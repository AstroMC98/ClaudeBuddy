'use strict';

(function main() {
  const stage = document.getElementById('stage');
  const badge = document.getElementById('badge');

  const renderer = window.createProceduralRenderer();
  renderer.mount(stage);

  window.buddy.onStateChange((change) => {
    renderer.setState(change);
    badge.textContent = change.state;
    badge.classList.add('visible');
    clearTimeout(main.badgeTimer);
    main.badgeTimer = setTimeout(() => badge.classList.remove('visible'), 1600);
  });
})();
