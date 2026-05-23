document.addEventListener('DOMContentLoaded', () => {
  const statusIndicator = document.getElementById('server-status');
  const pulseDot = document.querySelector('.pulse-dot');
  const auditForm = document.getElementById('audit-form');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = document.querySelector('.btn-text');
  const loader = document.querySelector('.loader');
  const resultsContainer = document.getElementById('results-container');

  // Check server health
  async function checkHealth() {
    try {
      const res = await fetch('/health');
      if (res.ok) {
        statusIndicator.textContent = 'Server Online';
        pulseDot.classList.add('online');
      } else {
        throw new Error('Not OK');
      }
    } catch (e) {
      statusIndicator.textContent = 'Server Offline';
      pulseDot.classList.remove('online');
    }
  }

  // Initial health check
  checkHealth();
  setInterval(checkHealth, 30000); // Check every 30s

  // Handle Form Submission
  auditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const urlInput = document.getElementById('url').value;
    if (!urlInput) return;

    // UI Loading State
    btnText.classList.add('hidden');
    loader.classList.remove('hidden');
    submitBtn.disabled = true;

    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditRunId: `audit_${Date.now()}`,
          url: urlInput
        })
      });

      const data = await response.json();

      // Clear empty state if needed
      if (resultsContainer.classList.contains('results-empty')) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.remove('results-empty');
      }

      // Add Result Card
      const resultHTML = `
        <div class="result-item">
          <div class="result-header">
            <span class="result-url">${data.url}</span>
            <span class="result-status">Success</span>
          </div>
          <div class="result-meta">
            Audit ID: ${data.auditRunId} <br>
            Message: ${data.message}
          </div>
        </div>
      `;
      
      resultsContainer.insertAdjacentHTML('afterbegin', resultHTML);
      auditForm.reset();

    } catch (error) {
      console.error('Audit failed', error);
      alert('Failed to trigger audit. Check console.');
    } finally {
      // Restore UI State
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
      submitBtn.disabled = false;
    }
  });
});
