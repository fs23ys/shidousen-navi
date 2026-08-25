// カタカナをひらがなに変換し、全角英数字を半角に、大文字を小文字に統一する。
// これにより「あむろ」と入力しても「アムロジピン」がヒットするようになる。
export function toSearchKey(str) {
  if (!str) return '';
  return str
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角英数字→半角
    .toLowerCase();
}
