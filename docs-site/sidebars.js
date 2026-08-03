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
      label: '⏰ Scheduler',
      items: [
        'scheduler/rtdn',
        'scheduler/scheduler',
      ],
    },
    {
      type: 'category',
      label: '🔧 Helper & Service',
      items: [
        'helper/subscriptionService',
        'helper/playstore',
        'helper/applestore',
        'helper/uploadFile',
        'helper/emailHelper',
        'helper/shiftScheduleService',
      ],
    },
    {
      type: 'category',
      label: '🌐 Routes',
      items: [
        'routes/login',
        'routes/profile',
        'routes/absensi',
        'routes/izin',
        'routes/tugas',
        'routes/berkas',
        'routes/arsip',
        'routes/inbox',
        'routes/company',
        'routes/kontak',
        'routes/reimburse',
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
