/**
 * Scribd Downloader Extension - Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const docView = document.getElementById('docView');
  const emptyView = document.getElementById('emptyView');
  const docTitle = document.getElementById('docTitle');
  const pageCount = document.getElementById('pageCount');
  const btnClean = document.getElementById('btnClean');
  const btnOffline = document.getElementById('btnOffline');
  const offlineBtnText = document.getElementById('offlineBtnText');
  const progressBox = document.getElementById('progressBox');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const statusMessage = document.getElementById('statusMessage');

  // Query the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('scribd.com')) {
    showEmptyState();
    return;
  }

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    console.warn('Script already injected or permission denied:', err);
  }

  // Fetch page info
  chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_INFO' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.isDocPage) {
      // Not a document page
      showEmptyState();
      return;
    }

    docView.classList.remove('hidden');
    emptyView.classList.add('hidden');
    docTitle.textContent = response.title || 'Scribd Document';
    docTitle.title = response.title;
    pageCount.textContent = `${response.pageCount || 'Several'} pages detected`;
  });

  // Progress messages from content script, while it walks and captures pages.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'EXPORT_PROGRESS' && msg.progress) {
      const { current, total } = msg.progress;
      const pct = Math.round((current / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `Preparing page ${current} of ${total}… (${pct}%)`;
    }
  });

  // Action 1: Open Offline Standalone Tab
  btnOffline.addEventListener('click', () => {
    btnOffline.disabled = true;
    offlineBtnText.textContent = 'Scanning pages…';
    progressBox.classList.remove('hidden');
    progressFill.style.width = '5%';
    progressText.textContent = 'Auto-scrolling pages to load content…';

    chrome.tabs.sendMessage(tab.id, { action: 'EXPORT_OFFLINE_HTML' }, (res) => {
      btnOffline.disabled = false;
      offlineBtnText.textContent = 'Open Clean Copy';
      progressBox.classList.add('hidden');

      if (chrome.runtime.lastError || (res && !res.success)) {
        showStatus((res && res.error) || 'Could not open offline tab.', 'error');
      } else {
        showStatus(`Opening clean document in new tab…${missingNote(res)}`, 'success');
        setTimeout(() => window.close(), 1400);
      }
    });
  });

  // Action 2: Clean View (Unblur current tab)
  btnClean.addEventListener('click', () => {
    btnClean.disabled = true;
    chrome.tabs.sendMessage(tab.id, { action: 'CLEAN_VIEW' }, (res) => {
      btnClean.disabled = false;
      if (chrome.runtime.lastError || (res && !res.success)) {
        showStatus('Could not clean page.', 'error');
      } else {
        showStatus('Clean Reader Active! Overlays removed.', 'success');
        setTimeout(() => window.close(), 1200);
      }
    });
  });

  // A brief addendum for the success toast when some pages couldn't be
  // captured (locked, or never finished loading in time) - matches the
  // "N pages locked" indicator the web app shows for the same situation,
  // so the same fact isn't silently dropped just because this is a popup.
  function missingNote(res) {
    if (!res || !res.missingPages) return '';
    return ` (${res.missingPages} of ${res.totalPages} page${res.totalPages === 1 ? '' : 's'} skipped)`;
  }

  function showEmptyState() {
    docView.classList.add('hidden');
    emptyView.classList.remove('hidden');
  }

  function showStatus(text, type = 'success') {
    statusMessage.textContent = text;
    statusMessage.className = `status-msg status-${type}`;
    statusMessage.classList.remove('hidden');
    setTimeout(() => {
      statusMessage.classList.add('hidden');
    }, 4000);
  }
});
