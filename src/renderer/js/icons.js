'use strict';

// Minimal 24x24 stroke icon set (drawn for EvCam, no external dependency).
const PATHS = {
  video: '<rect x="3" y="6" width="12.5" height="12" rx="3"/><path d="m15.5 10.5 4.9-2.9a.7.7 0 0 1 1.1.6v7.6a.7.7 0 0 1-1.1.6l-4.9-2.9"/>',
  camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.3-1.7A1 1 0 0 1 9.4 4h5.2a1 1 0 0 1 .8.3L16.7 6h1.8A2.5 2.5 0 0 1 21 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micoff: '<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v5h-5"/>',
  mirror: '<path d="M12 3v18"/><path d="M8.5 7 3.5 12l5 5z"/><path d="m15.5 7 5 5-5 5z"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  switch: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>',
  flash: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  power: '<path d="M12 3v8M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.7 12.4a9.5 9.5 0 0 1 12.6 0M9 15.8a5 5 0 0 1 6 0"/><circle cx="12" cy="19.2" r="1" class="fill"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.4M12 17.4v.01"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  speaker: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 4.9 4.9l-8.8 8.8a2.1 2.1 0 0 1-3-3L16.4 8.4A4 4 0 0 0 14.5 6.5z" transform="translate(-1 -1)"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/>',
  lens: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/>',
  battery: '<rect x="3" y="8" width="16" height="9" rx="2.5"/><path d="M21 11v3M7 12.5h5"/>',
  videooff: '<path d="M3 3l18 18"/><path d="M10 6h2a3 3 0 0 1 3 3v1.5l5-2.9a.7.7 0 0 1 1.1.6v7.6M15 15v.5a2.5 2.5 0 0 1-2.5 2.5H6a3 3 0 0 1-3-3V9a3 3 0 0 1 1.2-2.4"/>',
  gauge: '<path d="M4 17.5a8.5 8.5 0 1 1 16 0"/><path d="m12 13.5 3.8-4.6"/><circle cx="12" cy="13.5" r="1.3" class="fill"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'
};

function svg(name, extra = '') {
  return `<svg class="ic ${extra}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

/** Replaces every <i data-ic="name"></i> placeholder with the matching inline SVG. */
function mountIcons(root = document) {
  root.querySelectorAll('i[data-ic]').forEach((node) => {
    node.outerHTML = svg(node.dataset.ic);
  });
}

module.exports = { svg, mountIcons };
