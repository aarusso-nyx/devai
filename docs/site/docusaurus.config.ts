import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'DEVAI',
  tagline: 'Human-supervised control for AI-assisted development.',
  url: 'https://aarusso-nyx.github.io',
  baseUrl: '/devai/',
  organizationName: 'aarusso-nyx',
  projectName: 'devai',
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { format: 'detect' },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: { sidebarPath: './sidebars.ts' },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: 'DEVAI',
      items: [
        { type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: 'Docs' },
        { to: '/docs/adopters', label: 'Adopters', position: 'left' },
        { to: '/docs/reference', label: 'Reference', position: 'left' },
      ],
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
  },
};

export default config;
