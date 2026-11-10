// Where the person is in each book, here and in the account (src/reading.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookReading, cleanPlace, decodePlace, encodePlace, keepLocalPlace, later, localPlace, ReadingRefused, type ReadingApi, type ReadingPlace } from '../src/reading.ts';

/** A Storage stand-in. */
function memory() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
}

const place = (paragraph: number, at: number, page = 1, pages = 100): ReadingPlace => ({ place: [paragraph, 0], page, pages, at });

/** An account that keeps what it is sent, latest first. */
function account(start: ReadingPlace | null = null) {
  const sent: ReadingPlace[] = [];
  let kept = start;
  let refuse = false;
  let offline = false;
  const api: ReadingApi = {
    async get() {
      if (offline) throw new Error('offline');
      return kept;
    },
    async put(_book, p) {
      if (refuse) throw new ReadingRefused();
      if (offline) throw new Error('offline');
      sent.push(p);
      kept = later(kept, p);
    },
  };
  return {
    api,
    sent,
    set kept(p: ReadingPlace | null) {
      kept = p;
    },
    refuse: () => void (refuse = true),
    offline: (on: boolean) => void (offline = on),
  };
}

test('a place is kept in this browser per book, and only valid ones come back', () => {
  const store = memory();
  keepLocalPlace('a', place(12, 1000), store);
  keepLocalPlace('b', place(3, 2000), store);
  assert.deepEqual(localPlace('a', store), place(12, 1000));
  assert.deepEqual(localPlace('b', store), place(3, 2000));
  assert.equal(localPlace('c', store), null);
  assert.equal(cleanPlace({ place: [1, -1], page: 1, pages: 2, at: 1 }), null);
  assert.equal(cleanPlace({ place: [1], page: 1, pages: 2, at: 1 }), null);
  assert.equal(cleanPlace('nonsense'), null);
});

test('this browser keeps a bounded number of books, the most recently read first', () => {
  const store = memory();
  for (let i = 0; i < 5; i++) keepLocalPlace(`book${i}`, place(i, i), store, 3);
  assert.equal(localPlace('book0', store), null);
  assert.equal(localPlace('book1', store), null);
  assert.deepEqual(localPlace('book4', store), place(4, 4));
});

test('the account’s times are put on this device’s clock by how long ago they were', () => {
  const text = encodePlace(place(7, 0, 30, 300));
  // Read 60 s before the server's now; this device's clock is a day off: it was still 60 s ago here.
  const here = 86_400_000 + 5_000_000;
  const decoded = decodePlace(text, 1_000_000 - 60_000, 1_000_000, here);
  assert.deepEqual(decoded, { place: [7, 0], page: 30, pages: 300, at: here - 60_000 });
  assert.equal(decodePlace(null, null, 1, here), null);
  assert.equal(decodePlace('not json', 1, 1, here), null);
});

test('reading sends the place once the reader stops, and only when the text moved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = account();
  const book = new BookReading('k', () => true, remote.api, memory());
  book.read({ place: [10, 0], page: 2, pages: 100 }, 1000);
  book.read({ place: [20, 0], page: 3, pages: 100 }, 2000);
  assert.equal(remote.sent.length, 0); // still turning pages
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.deepEqual(remote.sent.map((p) => p.place), [[20, 0]]);
  // The same text on a resized window: nothing new to send.
  book.read({ place: [20, 0], page: 5, pages: 180 }, 3000);
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.equal(remote.sent.length, 1);
});

test('a later reading on another device is taken; an earlier one is not', async () => {
  const store = memory();
  keepLocalPlace('k', place(10, 5000), store);
  const remote = account(place(40, 4000));
  const book = new BookReading('k', () => true, remote.api, store);
  assert.equal(await book.fromAccount(), null); // read here since
  remote.kept = place(80, 9000);
  assert.deepEqual(await book.fromAccount(), place(80, 9000));
  assert.deepEqual(localPlace('k', store), place(80, 9000));
  // Read back to an earlier chapter elsewhere, later: that wins too.
  remote.kept = place(5, 10_000);
  assert.deepEqual((await book.fromAccount())?.place, [5, 0]);
  book.close();
});

test('read here while offline: it is sent when the person comes back, and wins over what the account had', async () => {
  const remote = account(place(40, 1000));
  const book = new BookReading('k', () => true, remote.api, memory());
  remote.offline(true);
  book.read({ place: [60, 0], page: 6, pages: 100 }, 2000);
  await book.send();
  assert.equal(remote.sent.length, 0);
  remote.offline(false);
  assert.equal(await book.fromAccount(), null);
  assert.deepEqual(remote.sent.map((p) => p.place), [[60, 0]]);
});

test('without sync, places stay in this browser and the account is not asked again', async () => {
  const remote = account();
  let gets = 0;
  const get = remote.api.get;
  remote.api.get = (book) => (gets++, get(book));
  const signedOut = new BookReading('k', () => false, remote.api, memory());
  assert.equal(await signedOut.fromAccount(), null);
  assert.equal(gets, 0);

  remote.refuse();
  const book = new BookReading('k', () => true, remote.api, memory());
  book.read({ place: [1, 0], page: 1, pages: 2 });
  await book.send();
  book.read({ place: [2, 0], page: 2, pages: 2 });
  await book.send();
  assert.equal(await book.fromAccount(), null);
  assert.equal(gets, 0);
  assert.equal(remote.sent.length, 0);
});

test('where the view lands for a kept place is that reading, as old as it was, and is not sent over a later one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = memory();
  keepLocalPlace('k', place(50, 1000), store);
  const remote = account(place(90, 5000));
  const book = new BookReading('k', () => true, remote.api, store);
  // Opened here at paragraph 50; the window is another width, so the top of the view is a little further on.
  book.read({ place: [50, 40], page: 9, pages: 120 }, 9000, true);
  assert.deepEqual(book.current, { place: [50, 40], page: 9, pages: 120, at: 1000 });
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.equal(remote.sent.length, 0);
  // So the account's later reading (another device) is still taken.
  assert.deepEqual((await book.fromAccount())?.place, [90, 0]);
  // Reading on from there is new, and sent.
  book.read({ place: [90, 0], page: 30, pages: 120 }, 10_000, true);
  book.read({ place: [95, 0], page: 31, pages: 120 }, 11_000);
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.deepEqual(remote.sent.map((p) => p.place), [[95, 0]]);
});
