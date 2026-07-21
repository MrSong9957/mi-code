const LEADING_FRONTMATTER = /^---(\r?\n)[\s\S]*?\1---(?:\1|$)/;

/** Remove one complete leading YAML frontmatter block for display only. */
export function stripPlanFrontmatter(content: string): string {
  const match = content.match(LEADING_FRONTMATTER);
  if (!match) return content;
  return content.slice(match[0].length).replace(/^\r?\n/, '');
}
