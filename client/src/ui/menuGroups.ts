/**
 * How a menu's dividers are tidied once its hidden entries are gone, for every menu in the app (the menu bar, the
 * Mac menu bar, the phone drawer and right-click menus): no divider at either end or doubled, and no group of one.
 * A lone entry joins the group above it (the one below, when it is first), because a divider around a single entry
 * reads as clutter rather than grouping. Which entries a format hides changes from document to document, so this
 * is done here, after hiding, rather than by placing dividers by hand.
 *
 * A group that starts with a heading (`isHeading`, the phone drawer's sections) is already labelled: nothing joins it.
 */
export function tidyGroups<T>(items: readonly (T | 'separator')[], isHeading: (item: T) => boolean = () => false): (T | 'separator')[] {
  const groups: T[][] = [[]];
  for (const item of items) {
    if (item === 'separator') groups.push([]);
    else groups[groups.length - 1].push(item);
  }
  const kept = groups.filter((g) => g.length);
  const open = (g: T[] | undefined) => g !== undefined && !isHeading(g[0]);
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].length !== 1 || isHeading(kept[i][0])) continue;
    if (open(kept[i - 1])) {
      kept[i - 1].push(...kept.splice(i, 1)[0]);
      i -= 2;
    } else if (open(kept[i + 1])) {
      kept[i + 1].unshift(...kept.splice(i, 1)[0]);
      i -= 1;
    }
    i = Math.max(i, -1);
  }
  return kept.flatMap((g, i): (T | 'separator')[] => (i ? ['separator', ...g] : g));
}
