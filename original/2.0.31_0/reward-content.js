// Existing reward pages and old extension versions keep their original request path.
(() => {
  const nonce = new URL(location.href).searchParams.get('snsRewardSession');
  if (!nonce || window.__snsRewardBridge) return;
  window.__snsRewardBridge = true;
  const requestedLanguage = new URL(location.href).searchParams.get('lang');
  const language = ['ko','en','ja','es'].includes(requestedLanguage) ? requestedLanguage
    : ((navigator.languages?.[0] || navigator.language || '').toLowerCase().match(/^(ko|ja|es)\b/) || [])[1] || 'en';
  const ko = language === 'ko', ja = language === 'ja', es = language === 'es';
  let pending = false;
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('#claimBtn');
    if (!button || !event.isTrusted || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending) return;
    pending = true;
    button.disabled = true;
    const box = document.getElementById('statusBox');
    const label = document.getElementById('btnText');
    const original = label?.textContent;
    const show = (type, text) => {if (box) {box.className = `status-card ${type}`; box.textContent = text;}};
    if (label) label.textContent = ko ? '발급 처리 중...' : ja ? '利用券を発行中…' : es ? 'Emitiendo tu pase…' : 'Issuing your pass…';
    try {
      const result = await chrome.runtime.sendMessage({type: 'NB_CLAIM_REWARD', nonce});
      if (!result?.ok || !result.pass) throw new Error(result?.error || 'Request failed');
      const remaining = Math.max(0, Math.ceil((result.pass.expiresAt - Date.now()) / 60000));
      show('success', ko
        ? `${result.pass.temporary ? '서버 연결 지연으로 임시 이용권을 적용했습니다.' : '무료 이용권이 적용되었습니다.'} 남은 시간: 약 ${remaining}분. 확장 프로그램으로 돌아가세요.`
        : ja ? `${result.pass.temporary ? 'サーバーに接続できないため、仮の利用券を適用しました。' : '無料利用券を適用しました。'} 残り約${remaining}分。拡張機能に戻ってください。`
        : es ? `${result.pass.temporary ? 'Servidor no disponible. Pase temporal activo.' : 'Tu pase gratuito está activo.'} Quedan unos ${remaining} minutos. Vuelve a la extensión.`
        : `${result.pass.temporary ? 'Server unavailable. A temporary pass is active.' : 'Your free pass is active.'} About ${remaining} minutes remaining. Return to the extension.`);
      if (label) label.textContent = ko ? '✅ 무료 이용권 적용 완료' : ja ? '✅ 無料利用券を適用済み' : es ? '✅ Pase gratuito activo' : '✅ Free pass active';
      await chrome.runtime.sendMessage({type: 'FREE_PASS_ISSUED'});
    } catch (error) {
      const details = globalThis.ddalkkakErrorText?.(error.message,language) ?? error.message;
      show('error', ko ? `발급 실패: ${details}` : ja ? `利用券を発行できませんでした: ${details}` : es ? `No se pudo emitir el pase: ${details}` : `Could not issue the pass: ${details}`);
      button.disabled = false;
      if (label) label.textContent = original;
    } finally { pending = false; }
  }, true);
})();
