import crypto from 'node:crypto';

export default function simpleSriPlugin() {
  return {
    name: 'simple-sri',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html;

      // Extract all script and link tags that have href/src
      return html.replace(/<(script|link)([^>]+)>/g, (match, tag, attrs) => {
        const srcMatch = attrs.match(/(?:href|src)=["']([^"']+)["']/);
        if (!srcMatch) return match;
        
        const assetPath = srcMatch[1];
        if (!assetPath.startsWith('/assets/')) return match;
        
        const fileName = assetPath.replace(/^\//, '');
        const asset = ctx.bundle[fileName];
        
        if (asset) {
          const source = asset.type === 'asset' ? asset.source : asset.code;
          const hash = crypto.createHash('sha384').update(source).digest('base64');
          return `<${tag}${attrs} integrity="sha384-${hash}">`;
        }
        
        return match;
      });
    }
  };
}
