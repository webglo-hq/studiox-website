import type { Plugin } from 'vite';

/**
 * Turns the demo build into ONE self-contained index.html: JS and CSS are inlined so the page needs no
 * sub-resource fetches. That keeps it working from file://, any static host, and sandboxed iframes with an
 * opaque origin (where module scripts and fonts loaded by URL would need CORS headers).
 */
export function inlineDemoBundle(): Plugin {
  return {
    name: 'bookhand-inline-demo',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlAsset = Object.values(bundle).find(
        (item) => item.type === 'asset' && item.fileName.endsWith('index.html'),
      );
      if (!htmlAsset || htmlAsset.type !== 'asset') return;
      let html = String(htmlAsset.source);

      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'chunk' && item.isEntry) {
          // With code splitting off, Vite leaves its preload-list placeholder in the inlined dynamic import;
          // there is nothing to preload in a single file, so the helper gets an empty list.
          const code = item.code.replace(/__VITE_PRELOAD__/g, 'void 0').replace(/<\/script/gi, '<\\/script');
          const tag = new RegExp(`<script[^>]*src="[^"]*${escapeRegExp(fileName)}"[^>]*></script>`);
          html = html.replace(tag, () => `<script type="module">${code}</script>`);
          delete bundle[fileName];
        } else if (item.type === 'asset' && fileName.endsWith('.css')) {
          const css = String(item.source).replace(/<\/style/gi, '<\\/style');
          const tag = new RegExp(`<link[^>]*href="[^"]*${escapeRegExp(fileName)}"[^>]*>`);
          html = html.replace(tag, () => `<style>${css}</style>`);
          delete bundle[fileName];
        }
      }
      // Remove modulepreload hints that would point at deleted chunks.
      html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
      htmlAsset.source = html;
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
