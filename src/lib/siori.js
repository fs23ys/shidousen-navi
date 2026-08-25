// 「くすりのしおり」(RAD-AR、rad-ar.or.jp)の検索候補APIを呼び出し、薬品名に一致する
// 「しおり」のIDを探すための非公式な連携ロジック。
//
// これは非公式なAPIです(RAD-ARが公式に提供している外部連携仕様ではありません)。
// 将来レスポンス形式や提供状況が変わって動かなくなる可能性があるため、
// 呼び出し側(main.js)は必ず失敗時にGoogle site:検索へフォールバックすること。

// 「エストラジオール錠0.5mg「F」［更年期障害...］」のような
// メーカー名「」・適応症［］などの括弧内を除去し、全角英数字を半角に統一して比較しやすくする
export function normalizeSioriName(s) {
  if (!s) return '';
  return s
    .replace(/「[^」]*」/g, '')
    .replace(/［[^］]*］/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[（）()]/g, '')
    .replace(/\s+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

// CORS制限なし(Access-Control-Allow-Origin: *)であることを確認済み。
// 見つかればそのIDを、見つからない・通信に失敗した場合はnullを返す(呼び出し側でフォールバック)。
export async function fetchSioriId(drugName) {
  const endpoint = `https://www.rad-ar.or.jp/siori_register/siori_api/?v=25&r=k&k=t&w=${encodeURIComponent(drugName)}&g=0`;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) return null;

    const target = normalizeSioriName(drugName);
    // 1. 正規化した名前が完全一致するものを最優先
    let chosen = items.find((it) => normalizeSioriName(it.name) === target);
    // 2. なければ、正規化した名前が前方一致するものを探す
    if (!chosen) {
      chosen = items.find(
        (it) =>
          normalizeSioriName(it.name).startsWith(target) ||
          target.startsWith(normalizeSioriName(it.name)),
      );
    }
    // 3. それでもなければ、候補の先頭(APIが最も関連度が高いと判断したもの)を採用
    if (!chosen) chosen = items[0];
    return chosen.id;
  } catch (e) {
    // ネットワークエラーなど。呼び出し側でGoogle site:検索にフォールバックする。
    return null;
  }
}

export function sioriDirectUrl(id) {
  return `https://www.rad-ar.or.jp/siori/search/result?n=${id}`;
}
