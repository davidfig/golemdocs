import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFields, interpretPage, N, PdfDict, PdfDocument, PdfStream, PdfString, readFields, type FormField } from '../src/index.ts';

const RADIO = 1 << 15;
const PUSHBUTTON = 1 << 16;
const COMBO = 1 << 17;

/** A form with a nested text field, a check box, a radio group, a drop-down, a signature and a button. */
async function form(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([600, 800]);
  const stream = () => doc.add(new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10] }), new Uint8Array()));
  const states = (on: string) => new PdfDict({ N: new PdfDict({ [on]: stream(), Off: stream() }) });
  const widget = (rect: number[], extra: Record<string, unknown> = {}) => new PdfDict({ Type: N('Annot'), Subtype: N('Widget'), Rect: rect, P: page.ref, ...(extra as object) } as never);

  const person = doc.add(new PdfDict({ T: PdfString.text('person') }));
  const name = doc.add(widget([100, 700, 300, 720], { T: PdfString.text('name'), FT: N('Tx'), V: PdfString.text('Ann'), Parent: person, DA: PdfString.text('/Helv 11 Tf 0 g') }));
  doc.dict(person)!.set('Kids', [name]);
  const agree = doc.add(widget([100, 660, 115, 675], { T: PdfString.text('agree'), FT: N('Btn'), V: N('Yes'), AS: N('Yes'), AP: states('Yes') }));
  const color = doc.add(new PdfDict({ T: PdfString.text('color'), FT: N('Btn'), Ff: RADIO, V: N('Blue') }));
  const red = doc.add(widget([100, 620, 112, 632], { Parent: color, AS: N('Off'), AP: states('Red') }));
  const blue = doc.add(widget([130, 620, 142, 632], { Parent: color, AS: N('Blue'), AP: states('Blue') }));
  doc.dict(color)!.set('Kids', [red, blue]);
  const size = doc.add(widget([100, 580, 200, 596], { T: PdfString.text('size'), FT: N('Ch'), Ff: COMBO, Opt: [PdfString.text('S'), [PdfString.text('M'), PdfString.text('Medium')]], V: PdfString.text('M') }));
  const sig = doc.add(widget([100, 500, 300, 540], { T: PdfString.text('sig'), FT: N('Sig') }));
  const button = doc.add(widget([400, 500, 480, 520], { T: PdfString.text('go'), FT: N('Btn'), Ff: PUSHBUTTON }));
  page.dict.set('Annots', [name, agree, red, blue, size, sig, button]);
  doc.catalog.set('AcroForm', doc.add(new PdfDict({ Fields: [person, agree, color, size, sig, button] })));
  return doc.save();
}

const byName = (fields: FormField[], name: string) => fields.filter((f) => f.name === name);

test('fillable fields are read, one per widget, with their values', async () => {
  const fields = readFields(PdfDocument.load(await form()));
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.value]),
    [
      ['person.name', 'text', 'Ann'],
      ['agree', 'checkbox', 'Yes'],
      ['color', 'radio', 'Blue'],
      ['color', 'radio', 'Blue'],
      ['size', 'choice', 'M'],
    ],
  );
  assert.equal(fields[0].fontSize, 11);
  assert.deepEqual(fields[0].rect, [100, 700, 300, 720]);
  assert.deepEqual(byName(fields, 'color').map((f) => f.onState), ['Red', 'Blue']);
  assert.equal(fields[4].combo, true);
  assert.deepEqual(fields[4].options, [{ value: 'S', label: 'S' }, { value: 'M', label: 'Medium' }]);
});

test('filled values are written as an incremental update and read back', async () => {
  const original = await form();
  const doc = PdfDocument.load(original);
  const fields = readFields(doc).map((f): FormField => {
    if (f.name === 'person.name') return { ...f, value: 'Bea Smith' };
    if (f.name === 'agree') return { ...f, value: '' };
    if (f.name === 'color') return { ...f, value: 'Red' };
    if (f.name === 'size') return { ...f, value: 'S' };
    return f;
  });
  applyFields(doc, fields);
  const saved = await doc.save({ incremental: true });
  assert.deepEqual(saved.subarray(0, original.length), original);
  const back = PdfDocument.load(saved);
  assert.deepEqual(readFields(back).map((f) => f.value), ['Bea Smith', '', 'Red', 'Red', 'S']);
  const annots = back.pages[0].annotations;
  assert.deepEqual(annots.slice(1, 4).map((a) => a.name('AS')), ['Off', 'Red', 'Off']);
  // The text field has a new appearance showing its value.
  const ap = back.resolve(back.dict(annots[0].get('AP'))?.get('N'));
  assert.ok(ap instanceof PdfStream);
  assert.match(new TextDecoder().decode(back.streamData(ap)), /Tj/);
  assert.equal(back.dict(back.catalog.get('AcroForm'))?.get('NeedAppearances'), true);
});

test('fields are moved, renamed, added and removed; buttons and signatures stay', async () => {
  const doc = PdfDocument.load(await form());
  const fields = readFields(doc);
  const next: FormField[] = [
    { ...fields[0], name: 'person.first', rect: [100, 690, 320, 712] },
    { ...fields[1], name: 'consent' },
    { id: 'new-1', name: 'email', kind: 'text', page: 0, rect: [100, 450, 300, 470], value: 'a@b.c' },
    { id: 'new-2', name: 'subscribe', kind: 'checkbox', page: 0, rect: [100, 420, 112, 432], value: 'Yes', onState: 'Yes' },
  ];
  applyFields(doc, next);
  const back = PdfDocument.load(await doc.save({ incremental: true }));
  assert.deepEqual(
    readFields(back).map((f) => [f.name, f.kind, f.value, f.rect]),
    [
      ['person.first', 'text', 'Ann', [100, 690, 320, 712]],
      ['consent', 'checkbox', 'Yes', [100, 660, 115, 675]],
      ['email', 'text', 'a@b.c', [100, 450, 300, 470]],
      ['subscribe', 'checkbox', 'Yes', [100, 420, 112, 432]],
    ],
  );
  assert.ok(back.pages[0].annotations.some((a) => a.name('FT') === 'Sig'), 'signature kept');
  const acro = back.dict(back.catalog.get('AcroForm'))!;
  const top = (back.array(acro.get('Fields')) ?? []).map((r) => back.dict(r)?.get('T')).map((t) => (t instanceof PdfString ? t.text : null));
  assert.deepEqual(top, ['person', 'consent', 'sig', 'go', 'email', 'subscribe']);
});

test('a text box can become several lines, and a drop-down get new options', async () => {
  const doc = PdfDocument.load(await form());
  applyFields(doc, readFields(doc).map((f) => (f.kind === 'text' ? { ...f, multiline: true } : f.kind === 'choice' ? { ...f, options: [{ value: 'L', label: 'Large' }] } : f)));
  const back = readFields(PdfDocument.load(await doc.save({ incremental: true })));
  assert.equal(back[0].multiline, true);
  assert.deepEqual(back[4].options, [{ value: 'L', label: 'Large' }]);
});

test('renaming out of a parent moves the field to the top, keeping what it inherited', async () => {
  const doc = PdfDocument.load(await form());
  const fields = readFields(doc);
  applyFields(doc, fields.map((f) => (f.name === 'person.name' ? { ...f, name: 'fullName' } : f)));
  const back = PdfDocument.load(await doc.save({ incremental: true }));
  const text = readFields(back)[0];
  assert.equal(text.name, 'fullName');
  assert.equal(text.value, 'Ann');
  assert.equal(text.kind, 'text');
});

test('the renderer can leave fields out, for the app to draw them', async () => {
  const doc = PdfDocument.load(await form());
  applyFields(doc, readFields(doc).map((f) => (f.kind === 'text' ? { ...f, value: 'Visible' } : f)));
  const page = PdfDocument.load(await doc.save({ incremental: true })).pages[0];
  const shown = interpretPage(page).glyphRuns.flatMap((r) => r.glyphs.map((g) => g.unicode)).join('');
  assert.equal(shown, 'Visible');
  assert.equal(interpretPage(page, { hideFields: true }).glyphRuns.length, 0);
});
