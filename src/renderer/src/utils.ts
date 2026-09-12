export function shortPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) return '~/' + p.slice(home.length).split('/').slice(1).join('/')
  return p
}
