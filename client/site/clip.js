// Holden on the marketing pages: the app's assistant, as a scripted sample. No AI and no network: replies are picked from a
// short list by keywords. The bubble says so at the top, and the real Holden (which is in the app) is the only one that uses AI.
(function () {
  var root = document.getElementById('clip');
  if (!root) return;
  var body = root.querySelector('.wm-clip-body');
  var panel = root.querySelector('.wm-clip-panel');
  var log = root.querySelector('.wm-clip-log');
  var input = root.querySelector('.wm-clip-input');
  var form = root.querySelector('.wm-clip-form');
  var HIDDEN = 'golem.site.clip.hidden';

  try {
    if (localStorage.getItem(HIDDEN) === '1') return;
  } catch (e) {}
  root.hidden = false;

  // --- What Holden says -----------------------------------------------------------------------------------------------------
  var RULES = [
    [/\b(are you|is this|you)\b.*\b(ai|gpt|chatgpt|claude|llm|bot|robot|real|smart|intelligent|alive)\b|\b(ai|gpt|chatgpt|llm)\b/i, [
      'Honest answer: not here. On this page I am a handful of if-statements in a trench coat. In the app, the real me is an AI that can read and edit your document. That one is for subscribers.',
    ]],
    [/\b(hi|hello|hey|yo|howdy|sup)\b/i, ['Hello! I hold things together. Mostly paper, occasionally conversations.', 'Hi there! I would shake your hand, but I am a clip.']],
    [/\b(cancel|refund|refunds|unsubscribe|billing|invoice)\b/i, [
      'You can manage or cancel a subscription from inside the app. Refunds are beyond me. I only handle paper, and not even that, I just clip it.',
    ]],
    [/\b(free|price|prices|pricing|cost|costs|pay|paid|subscribe|subscription|subscriptions|money|cheap|expensive|trial|plan|plans|how much|sync)\b/i, [
      'Good news: using the app locally is free. Opening, editing, converting, and downloading never need an account, and your documents stay in your browser. The paid part is sync: $5 a month keeps your documents in your account, on any device, and lets you share them with people. Your first month is free, and the real me in the app comes with it.',
      'Short version: using the app locally is free, no account needed. Subscribe only if you want sync, sharing with people, and the AI version of me. It is $5 a month, and the first month is free.',
    ]],
    [/\bpdf/i, ['PDFs! Edit the text where it sits, black out the secrets, shuffle the pages. I only hold pages together. No editing from me.', 'I love a good PDF. So many pages to clamp.']],
    [/\b(word|docx|doc)\b/i, ['Word documents open fine and save back as .docx. Even the old .doc ones, which is very retro of us.', 'Word files? Yes. Laid out the way Word does it, minus the ribbon.']],
    [/\b(markdown|md)\b/i, ['Markdown is one Convert To away, and it comes back with your formatting. Pound signs for everyone!']],
    [/\b(convert|format|formats|epub|csv|html|latex)\b/i, ['More than twenty formats. I would list them, but the chips on the home page already did, and they are prettier than me.']],
    [/\b(share|sharing|collab|collaborate|together|live|team)\b/i, ['Sharing needs a sign-in, but then you edit together, live, with names and cursors. I get jealous of cursors. They get to move.']],
    [/\b(privacy|private|data|track|tracking|spy|safe)\b/i, ['Nothing you type to me leaves this page. I have no server, no memory, and honestly not that much to say.']],
    [/\b(dark|theme|themes|color|colour|scheme)\b/i, ['The app has five color schemes and a dark mode. I stay black either way. It is slimming.']],
    [/\b(joke|funny|laugh|pun)\b/i, ['Why did the binder clip get promoted? It really held the team together.', 'I would tell a paper joke, but it might be tearable.']],
    [/\b(thanks|thank you|thx|cheers)\b/i, ['Any time! I will be here, clamped to the corner of your screen.']],
    [/\b(bye|goodbye|later|cya)\b/i, ['Bye! I will keep watching your cursor. Not creepy. Just eyes.']],
    [/\b(love|cute|handsome|beautiful|pretty|cool)\b/i, ['Stop it, I am turning a darker shade of black.']],
    [/\b(typo|typing|spell|spelling|grammar)\b/i, ['The app checks spelling and grammar as you type. I check nothing. I am a clip.']],
    [/\b(letter|resume|essay|report|novel|thesis)\b/i, ['Writing something important? The app lays it out like Word does. I will supervise, silently, from the corner.']],
    [/\bhelp\b/i, ['I can offer three things: opinions about this page, bad clip puns, and a link to the app. The link is the useful one.']],
  ];
  var FALLBACK = [
    'I am a scripted demo, so I only know a few tricks. Try asking about PDFs, sharing, or whether I am AI.',
    'Interesting! I understood none of that, but I nodded with my eyebrows.',
    'Hmm. I would need a real brain for that one. The app version of me has one.',
    'I am clipping that thought for later. (I will not. I have no memory.)',
    'Beep boop. Wait, that is a robot. I am a clip.',
    'Great question! Sadly, I only have canned answers. The real me can look at your actual document and tell you.',
  ];
  var GREETING = 'Hi, I am Holden! I am the website demo, so I am all script and no brain. Ask me something silly.';
  var REMINDER = 'By the way, I am not AI. I am a lookup table with eyebrows. The real Holden is in the app and can rewrite your paragraphs.';

  var last = '';
  var count = 0;
  var fallbackAt = 0;
  function pick(list) {
    var options = list.filter(function (x) { return x !== last; });
    return options[Math.floor(Math.random() * options.length)] || list[0];
  }
  function reply(text) {
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(text)) return pick(RULES[i][1]);
    var out = FALLBACK[fallbackAt++ % FALLBACK.length];
    return out;
  }

  // --- The bubble ---------------------------------------------------------------------------------------------------------
  function say(text, who) {
    var m = document.createElement('div');
    m.className = 'wm-clip-msg' + (who === 'user' ? ' user' : '');
    m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }
  function state(s) { root.dataset.state = s; }

  var greeted = false;
  function open() {
    panel.hidden = false;
    body.setAttribute('aria-expanded', 'true');
    if (!greeted) {
      greeted = true;
      say(GREETING);
      var chips = document.createElement('div');
      chips.className = 'wm-clip-chips';
      ['Are you AI?', 'How much does it cost?', 'Can you edit PDFs?', 'Tell me a joke'].forEach(function (q) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = q;
        b.addEventListener('click', function () { chips.remove(); ask(q); });
        chips.appendChild(b);
      });
      log.appendChild(chips);
    }
    input.focus();
  }
  function close() {
    panel.hidden = true;
    body.setAttribute('aria-expanded', 'false');
  }

  var busy = false;
  function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    var chips = log.querySelector('.wm-clip-chips');
    if (chips) chips.remove();
    say(text, 'user');
    input.value = '';
    state('thinking');
    var wait = say('');
    wait.classList.add('wm-clip-dots');
    setTimeout(function () {
      wait.classList.remove('wm-clip-dots');
      var out = reply(text);
      last = out;
      count++;
      wait.textContent = out;
      // Now and then, the reminder that none of this is AI.
      if (count % 4 === 0) say(REMINDER);
      log.scrollTop = log.scrollHeight;
      state('happy');
      busy = false;
      setTimeout(function () { if (root.dataset.state === 'happy') state('idle'); }, 700);
    }, 550 + Math.random() * 500);
  }

  body.addEventListener('click', function () { if (panel.hidden) open(); else close(); });
  root.querySelector('.wm-clip-close').addEventListener('click', close);
  root.querySelector('.wm-clip-hide').addEventListener('click', function () {
    root.hidden = true;
    try { localStorage.setItem(HIDDEN, '1'); } catch (e) {}
  });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });

  // Typing: Holden raises an eyebrow and wobbles while you type, and settles a moment after you stop.
  var settle = 0;
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    if (busy) return;
    state('thinking');
    clearTimeout(settle);
    settle = setTimeout(function () { if (!busy) state('idle'); }, 900);
  });

  // The eyes follow the pointer, as in the app (assistant/index.ts).
  if (!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    var eyes = Array.prototype.slice.call(root.querySelectorAll('.wm-clip-face .eye'));
    var TILT = (7 * Math.PI) / 180, COS = Math.cos(TILT), SIN = Math.sin(TILT), frame = 0, x = 0, y = 0;
    var look = function () {
      frame = 0;
      if (root.hidden || root.dataset.state === 'thinking') return;
      eyes.forEach(function (eye) {
        var box = eye.getBoundingClientRect();
        var dx = x - (box.left + box.width / 2), dy = y - (box.top + box.height / 2);
        var length = Math.hypot(dx, dy) || 1, strength = Math.min(1, length / 90);
        var sx = (dx / length) * strength * 4, sy = (dy / length) * strength * 5.5;
        eye.style.setProperty('--look-x', (sx * COS - sy * SIN).toFixed(2) + 'px');
        eye.style.setProperty('--look-y', (sx * SIN + sy * COS).toFixed(2) + 'px');
      });
    };
    window.addEventListener('pointermove', function (e) {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    }, { passive: true });
  }
})();
