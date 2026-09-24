const search = document.querySelector('#search');
const groups = [...document.querySelectorAll('.nav-group')];
const noResults = document.querySelector('#no-results');

search?.addEventListener('input', () => {
  const query = search.value.trim().toLowerCase();
  let shown = 0;
  for (const group of groups) {
    const name = group.querySelector('.nav-package')?.textContent?.toLowerCase() ?? '';
    const all = name.includes(query);
    let matches = 0;
    for (const link of group.querySelectorAll('[data-search]')) {
      link.hidden = !all && !link.dataset.search.includes(query);
      if (!link.hidden) matches++;
    }
    group.hidden = !all && matches === 0;
    if (!group.hidden) shown++;
  }
  noResults.hidden = shown !== 0;
});

const status = document.querySelector('#source-status');
const revisionUrl = `${document.documentElement.dataset.basePath ?? ''}/revision`;
if (document.documentElement.dataset.revision) {
  setInterval(async () => {
    try {
      const response = await fetch(revisionUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('offline');
      const { revision } = await response.json();
      if (revision !== document.documentElement.dataset.revision) location.reload();
      else status.textContent = 'Live from the api socket';
    } catch {
      status.textContent = 'Discovery API unavailable · retrying';
    }
  }, 15000);
}
