const KEYWORDS = ['服薬指導せん', '患者向け資料', 'くすりのしおり', '患者向医薬品ガイド'];

export function buildSiteSearchUrl(domain, drugName) {
  const kw = KEYWORDS.map((k) => `"${k}"`).join(' OR ');
  const q = `site:${domain} ${drugName} (${kw})`;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}
