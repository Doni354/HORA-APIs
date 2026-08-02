/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  mainSidebar: [
    'intro',
    'architecture',
    {
      type: 'category',
      label: '🔐 Subscription & IAP',
      collapsed: false,
      items: [
        'subscription/overview',
        'subscription/google-play',
        'subscription/apple',
        'subscription/iap-tokens',
      ],
    },
    {
      type: 'category',
      label: '⚙️ Backend',
      items: [
        'backend/getting-started',
        'backend/middleware',
        'backend/env-config',
      ],
    },
    {
      type: 'category',
      label: '📦 Fitur',
      items: [
        'features/storage',
        'features/notifications',
        'features/attendance',
      ],
    },
  ],
};

export default sidebars;
