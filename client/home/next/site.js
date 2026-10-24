// The next marketing site's behavior: the home page's demo, the clip, the copy button and the download links.
// Each part runs only on a page that has it. Text comes from the page (it is translated there), never from here.
(function () {
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The menu bar's access keys, as in the app: holding Alt underlines them, and Alt with the letter opens that page.
  (function () {
    var chrome = document.querySelector('.chrome');
    if (!chrome) return;
    var keys = {};
    chrome.querySelectorAll('.menus a').forEach(function (a) {
      var u = a.querySelector('u');
      if (u) keys['Key' + u.textContent.toUpperCase()] = a;
    });
    function cues(on) { chrome.classList.toggle('cues', on); }
    addEventListener('keydown', function (e) {
      if (e.key === 'Alt') return cues(true);
      if (!e.altKey || e.ctrlKey || e.metaKey || !keys[e.code]) return;
      e.preventDefault();
      location.href = keys[e.code].href;
    });
    addEventListener('keyup', function (e) { if (e.key === 'Alt') cues(false); });
    addEventListener('blur', function () { cues(false); });
  })();

  // The editor picture: choosing a file in its sidebar (or, on a phone, a tab) shows how the editor looks for that kind of
  // file, toolbar and all. Until someone chooses, it steps through the files on its own while it is on screen.
  (function () {
    var editor = document.getElementById('editor');
    if (!editor) return;
    var tabs = document.getElementById('edTabs');
    var hint = document.getElementById('filesHint');
    var kinds = [].map.call(editor.querySelectorAll('[data-file]'), function (el) { return el.dataset.file; });
    var current = kinds[0];
    var timer = null;
    var chosen = false;
    function show(kind) {
      current = kind;
      if (tabs) tabs.querySelectorAll('[data-show]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.show === kind)); });
      editor.querySelectorAll('[data-for]').forEach(function (el) { el.hidden = el.dataset.for !== kind; });
      editor.querySelectorAll('[data-file]').forEach(function (el) {
        el.classList.toggle('current', el.dataset.file === kind);
        el.setAttribute('aria-pressed', String(el.dataset.file === kind));
      });
    }
    function pause() { clearInterval(timer); timer = null; }
    function play() {
      if (chosen || reduce || timer) return;
      timer = setInterval(function () { show(kinds[(kinds.indexOf(current) + 1) % kinds.length]); }, 3500);
    }
    function choose(kind) {
      chosen = true;
      pause();
      if (hint) hint.hidden = true;
      show(kind);
    }
    editor.addEventListener('click', function (e) { var row = e.target.closest('[data-file]'); if (row) choose(row.dataset.file); });
    editor.addEventListener('keydown', function (e) {
      var row = e.target.closest('[data-file]');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(row.dataset.file); }
    });
    if (tabs) tabs.addEventListener('click', function (e) { var b = e.target.closest('[data-show]'); if (b) choose(b.dataset.show); });
    // Hold still while the pointer is over it, so it doesn't change under someone reading it.
    editor.addEventListener('mouseenter', pause);
    editor.addEventListener('mouseleave', play);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) play(); else pause(); }, { threshold: 0.5 }).observe(editor);
    }
  })();

  // The demo: you ask your ai (in a chat app or a terminal), Golem Docs shows each change as it lands, then you add a line yourself.
  // Until someone picks one of the pane's tabs, it plays in the chat app, then again in the terminal, and so on.
  (function () {
    var demo = document.getElementById('demo');
    if (!demo) return;
    var ask = document.getElementById('demoAsk').textContent;
    var you = document.getElementById('demoYou').textContent;
    var steps = [].map.call(document.querySelectorAll('#demoSteps li'), function (li) {
      return { chat: li.innerHTML, term: li.dataset.term, at: +li.dataset.at || 0, last: li.hasAttribute('data-last') };
    });
    var mode = 'chat';
    var mine = document.getElementById('mine');
    var termLines = document.getElementById('termLines');
    var chatSteps = document.getElementById('chatSteps');
    var chatAsk = document.getElementById('chatAsk');
    var syncEl = document.getElementById('sync');
    var syncText = document.getElementById('syncText');
    var timers = [];
    var chosen = false;
    var hovering = false;
    var switchWaiting = false;

    function reveal(step) {
      demo.querySelectorAll('[data-at]').forEach(function (el) { el.classList.toggle('shown', +el.dataset.at <= step); });
    }
    function termLine(html) { var div = document.createElement('div'); div.className = 'ln'; div.innerHTML = html; termLines.appendChild(div); return div; }
    function chatLine(s) { var li = document.createElement('li'); if (s.last) li.className = 'last'; li.innerHTML = s.chat; chatSteps.appendChild(li); }
    function busy() {
      syncEl.classList.add('busy');
      syncText.textContent = syncText.dataset.busy;
      timers.push(setTimeout(function () { syncEl.classList.remove('busy'); syncText.textContent = syncText.dataset.idle; }, 700));
    }
    function typeInto(el, text, from, speed, done) {
      for (var i = 1; i <= text.length; i++) (function (i) {
        timers.push(setTimeout(function () { el.textContent = text.slice(0, i); if (i === text.length && done) done(); }, from + i * speed));
      })(i);
    }
    function clear() {
      timers.forEach(clearTimeout);
      timers = [];
      termLines.innerHTML = '';
      chatSteps.innerHTML = '';
      chatAsk.textContent = '';
      mine.textContent = '';
      reveal(0);
    }
    var prompt = '<span class="dim">~/Documents/Golem Docs $</span> ai';
    function finalState() {
      clear();
      chatAsk.textContent = ask;
      termLine(prompt);
      termLine('<span class="you">&gt;</span> ').appendChild(document.createTextNode(ask));
      steps.forEach(function (s) { termLine(s.term); chatLine(s); });
      termLine('<span class="cur"></span>');
      mine.textContent = you;
      reveal(99);
    }
    function play() {
      if (reduce) return finalState();
      clear();
      var at = 300;
      if (mode === 'term') {
        timers.push(setTimeout(function () { termLine(prompt); }, at));
        at += 500;
        timers.push(setTimeout(function () {
          var span = document.createElement('span');
          termLine('<span class="you">&gt;</span> ').appendChild(span);
          typeInto(span, ask, 0, 22);
        }, at));
      } else typeInto(chatAsk, ask, at, 22);
      at += 700 + ask.length * 22;
      steps.forEach(function (s) {
        timers.push(setTimeout(function () {
          if (mode === 'term') termLine(s.term);
          else chatLine(s);
          if (s.at) timers.push(setTimeout(function () { reveal(s.at); busy(); }, 350));
        }, at));
        at += s.last ? 1400 : 900;
      });
      timers.push(setTimeout(function () {
        if (mode === 'term') termLine('<span class="cur"></span>');
        reveal(7);
        typeInto(mine, you, 0, 45, busy);
      }, at));
      // Then the other way of asking, after a moment to take it in.
      timers.push(setTimeout(switchOver, at + you.length * 45 + 2800));
    }
    function switchOver() {
      if (chosen) return;
      if (hovering) { switchWaiting = true; return; }
      setMode(mode === 'chat' ? 'term' : 'chat');
    }
    var tabs = { chat: document.getElementById('tabChat'), term: document.getElementById('tabTerm') };
    function showPane(m) {
      mode = m;
      document.getElementById('aiPane').dataset.mode = m;
      for (var k in tabs) tabs[k].setAttribute('aria-selected', String(k === m));
      document.getElementById('chat').hidden = m !== 'chat';
      document.getElementById('term').hidden = m !== 'term';
    }
    function setMode(m) {
      switchWaiting = false;
      showPane(m);
      play();
    }
    // The demo is as tall as the taller of its two finished views, so neither playing nor switching moves the page.
    var started = false;
    var measuredWidth = 0;
    function measure() {
      var keep = mode;
      var tallest = 0;
      demo.style.minHeight = '';
      ['chat', 'term'].forEach(function (m) { showPane(m); finalState(); tallest = Math.max(tallest, demo.offsetHeight); });
      showPane(keep);
      demo.style.minHeight = tallest + 'px';
      measuredWidth = demo.offsetWidth;
      if (started) play();
      else finalState();
    }
    tabs.chat.addEventListener('click', function () { chosen = true; setMode('chat'); });
    tabs.term.addEventListener('click', function () { chosen = true; setMode('term'); });
    document.getElementById('replay').addEventListener('click', play);
    // Never switch under the pointer: wait until it leaves.
    demo.addEventListener('mouseenter', function () { hovering = true; });
    demo.addEventListener('mouseleave', function () { hovering = false; if (switchWaiting) switchOver(); });

    measure();
    if (document.fonts) document.fonts.ready.then(measure);
    var resizing = null;
    addEventListener('resize', function () {
      clearTimeout(resizing);
      resizing = setTimeout(function () { if (demo.offsetWidth !== measuredWidth) measure(); }, 200);
    });
    // Start when the demo comes into view, so it is not over before anyone looks.
    if ('IntersectionObserver' in window && !reduce) {
      new IntersectionObserver(function (entries, observer) {
        if (entries[0].isIntersecting) { observer.disconnect(); started = true; play(); }
      }, { threshold: 0.4 }).observe(demo);
    }
  })();

  // Clips load and play only when they are near the screen, and stay still for visitors who ask for less motion.
  document.querySelectorAll('video[data-src]').forEach(function (video) {
    function load() {
      video.src = video.dataset.src;
      if (reduce) video.controls = true;
      else video.play().catch(function () { video.controls = true; });
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries, observer) {
        if (entries[0].isIntersecting) { observer.disconnect(); load(); }
      }, { rootMargin: '200px' }).observe(video);
    } else load();
  });

  // Copy buttons: data-copy names the element whose text they copy.
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    var label = button.textContent;
    button.addEventListener('click', function () {
      var source = document.getElementById(button.dataset.copy);
      function done(text) { button.textContent = text; setTimeout(function () { button.textContent = label; }, 1600); }
      function select() { var r = document.createRange(); r.selectNodeContents(source); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      try {
        navigator.clipboard.writeText(source.textContent).then(function () { done(button.dataset.copied); }, function () { select(); done(button.dataset.select); });
      } catch (e) { select(); done(button.dataset.select); }
    });
  });

  // Download: the installers of the latest release (published by `pnpm publish:desktop`), with the one for this computer first.
  (function () {
    var box = document.getElementById('dl');
    if (!box || !window.fetch) return;
    var text = document.getElementById('dl-text').dataset;
    var kinds = { mac: /\.dmg$/i, windows: /-setup\.exe$|\.exe$/i, linux: /\.appimage$/i };
    var agent = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    var mine = /android|iphone|ipad/i.test(ua) ? '' : /mac/i.test(agent) ? 'mac' : /win/i.test(agent) ? 'windows' : /linux|x11|cros/i.test(agent + ua) ? 'linux' : '';
    function size(bytes) { return (bytes / 1048576).toFixed(0) + ' MB'; }
    function link(file) { var a = document.createElement('a'); a.href = '/api/downloads/' + encodeURIComponent(file.name); a.textContent = file.name + ' (' + size(file.size) + ')'; return a; }
    fetch('/api/downloads').then(function (r) { if (!r.ok) throw new Error('none'); return r.json(); }).then(function (release) {
      var files = release.files || [];
      var main = null;
      if (mine) for (var i = 0; i < files.length && !main; i++) if (files[i].platform === mine && kinds[mine].test(files[i].name)) main = files[i];
      var button = document.getElementById('dl-main');
      if (main) {
        button.href = '/api/downloads/' + encodeURIComponent(main.name);
        button.textContent = text.get.replace('{platform}', text[mine]);
        document.getElementById('dl-note').hidden = mine !== 'windows';
      } else button.parentNode.hidden = true;
      document.getElementById('dl-version').textContent = text.version.replace('{version}', release.version);
      var list = document.getElementById('dl-list');
      ['mac', 'windows', 'linux'].forEach(function (platform) {
        files.filter(function (f) { return f.platform === platform; }).forEach(function (f) {
          var li = document.createElement('li');
          li.appendChild(document.createTextNode(text[platform] + ': '));
          li.appendChild(link(f));
          list.appendChild(li);
        });
      });
      box.hidden = false;
    }).catch(function () { document.getElementById('dl-soon').hidden = false; });
  })();
})();
