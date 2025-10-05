// ==== 自動＋手動リサイズ対応 ====
function autoResize(el) {
  const manualMin = Number(el.dataset.manualMin || 0);
  el.style.height = 'auto';
  const needed = el.scrollHeight;
  const target = Math.max(needed, manualMin);
  el.style.height = target + 'px';
}

function bindManualResizeSentinel(ta) {
  let resizing = false;
  const start = () => { resizing = true; };
  const end = () => {
    if (!resizing) return;
    resizing = false;
    const h = parseFloat(getComputedStyle(ta).height);
    ta.dataset.manualMin = String(Math.max(h, Number(ta.dataset.manualMin || 0)));
  };
  ta.addEventListener('mousedown', start);
  window.addEventListener('mouseup', end);
  ta.addEventListener('touchstart', start, { passive: true });
  window.addEventListener('touchend', end);
}

document.addEventListener('DOMContentLoaded', () => {
  const textareas = document.querySelectorAll('textarea');
  textareas.forEach(ta => {
    autoResize(ta);
    ta.addEventListener('input', () => autoResize(ta));
    bindManualResizeSentinel(ta);
  });

  document.getElementById('checkButton').addEventListener('click', checkGrammar);
  const qaInput = document.getElementById('qaInput');
  document.getElementById('qaButton').addEventListener('click', askQA);
  qaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      askQA();
    }
  });
});

// --- 添削 ---
async function checkGrammar() {
  const question = document.getElementById('questionText').value;
  const text = document.getElementById('englishText').value;
  const feedbackArea = document.getElementById('feedbackArea');

  feedbackArea.innerHTML = '<p class="loading">添削中...</p>';

  if (!text) {
    feedbackArea.innerHTML = '<p>英文を入力してください。</p>';
    return;
  }

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, text })
    });
    const data = await res.json();
    if (data.status === 'success') {
      feedbackArea.textContent = data.feedback || '';
    } else {
      feedbackArea.innerHTML = '<p style="color:red;">エラー: ' + (data.message || '不明なエラー') + '</p>';
    }
  } catch (error) {
    feedbackArea.innerHTML = '<p style="color:red;">リクエスト中にエラーが発生しました: ' + error.message + '</p>';
  }
}

// --- Q&A（1行入力 & 折りたたみ回答） ---
async function askQA() {
  const qaInput = document.getElementById('qaInput');
  const qa = qaInput.value.trim();
  if (!qa) return;

  const qaList = document.getElementById('qaList');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const wrap = document.createElement('div');
  wrap.className = 'qaSummaryLine';

  const qText = document.createElement('span');
  qText.textContent = `Q: ${qa}`;

  const badge = document.createElement('span');
  badge.className = 'qaBadge';
  badge.textContent = '回答生成中…';

  wrap.appendChild(qText);
  wrap.appendChild(badge);
  summary.appendChild(wrap);
  details.appendChild(summary);

  const answerDiv = document.createElement('div');
  answerDiv.className = 'qaAnswer';
  answerDiv.textContent = '生成中…';
  details.appendChild(answerDiv);
  qaList.prepend(details);

  const originalQuestion = document.getElementById('questionText').value || '';
  const originalText = document.getElementById('englishText').value || '';
  const feedbackPlain = document.getElementById('feedbackArea').textContent || '';

  qaInput.value = '';

  try {
    const res = await fetch('/api/qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: qa,
        originalQuestion,
        originalText,
        feedback: feedbackPlain
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      const answer = (data.answer || '(回答が空でした)');
      answerDiv.textContent = answer;
      badge.textContent = '完了';
      badge.style.background = '#d7ecff';
      badge.style.color = '#0b63b6';
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      answerDiv.style.transition = 'background-color 600ms';
      answerDiv.style.backgroundColor = '#fff8d6';
      setTimeout(() => { answerDiv.style.backgroundColor = ''; }, 700);
    } else {
      answerDiv.textContent = `エラー: ${data.message || '不明なエラー'}`;
      badge.textContent = '失敗';
      badge.style.background = '#fde3e3';
      badge.style.color = '#a50000';
      details.open = true;
    }
  } catch (error) {
    answerDiv.textContent = `問い合わせ中にエラーが発生しました: ${error.message}`;
    badge.textContent = '失敗';
    badge.style.background = '#fde3e3';
    badge.style.color = '#a50000';
    details.open = true;
  }
}
