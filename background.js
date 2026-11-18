// Side Panel Shot - service worker
// アイコンのクリック（またはショートカット）で、そのタブに content.js を注入する。
// 撮影そのもの（captureVisibleTab）は拡張機能側でしか呼べないので、ここで代行する。

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (e) {
    // chrome:// やウェブストアなど、スクリプトを注入できないページ
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '×' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 2500);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  if (!tab?.id) return;

  if (msg?.type === 'sps-capture') {
    (async () => {
      try {
        const now = await chrome.tabs.get(tab.id);
        if (!now.active) throw new Error('TAB_NOT_ACTIVE');
        const dataUrl = await chrome.tabs.captureVisibleTab(now.windowId, { format: 'png' });
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // 非同期で応答する
  }

  if (msg?.type === 'sps-badge') {
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#1a73e8' }).catch(() => {});
    chrome.action.setBadgeText({ tabId: tab.id, text: msg.text || '' }).catch(() => {});
  }
});
