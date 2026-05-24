import './card.js';

declare const __HA_UWW_VERSION__: string;

// eslint-disable-next-line no-console
console.info(
  `%c uww-assist-card %c v${__HA_UWW_VERSION__} `,
  'background:#03a9f4;color:#fff;font-weight:600;border-radius:3px 0 0 3px;padding:1px 6px',
  'background:#444;color:#fff;border-radius:0 3px 3px 0;padding:1px 6px',
);

export { UwwAssistCard } from './card.js';
