export const DEFAULT_AUDIT_DRAWER_WIDTH = 768;
export const MIN_AUDIT_DRAWER_WIDTH = 600;
const VIEWPORT_GUTTER = 16;

/**
 * Keeps the Clerk Audit drawer readable while ensuring it never extends past
 * the viewport. The drawer is anchored on the right, so dragging its left edge
 * left increases width and dragging right decreases it.
 */
export function clampAuditDrawerWidth(width, viewportWidth) {
  const availableWidth = Math.max(0, Number(viewportWidth) - VIEWPORT_GUTTER);
  const minimumWidth = Math.min(MIN_AUDIT_DRAWER_WIDTH, availableWidth);
  return Math.min(Math.max(Number(width) || minimumWidth, minimumWidth), availableWidth);
}
