/* ── Tab switching (paste vs upload) ──────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(target).classList.add('active');
  });
});

/* ── File upload ──────────────────────────────────────────────────────────── */
const uploadArea = document.getElementById('uploadArea');
const fileInput  = document.getElementById('resumeFile');
const uploadStatus = document.getElementById('uploadStatus');

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', e => {
  e.preventDefault();
  uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));

uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFileUpload(fileInput.files[0]);
});

async function handleFileUpload(file) {
  const allowed = ['.pdf', '.docx', '.txt'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    showUploadStatus('Unsupported file type. Use PDF, DOCX, or TXT.', true);
    return;
  }

  showUploadStatus('Parsing…', false);

  const form = new FormData();
  form.append('file', file);

  try {
    const res = await fetch('/parse-resume', { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) {
      showUploadStatus(data.error, true);
    } else {
      document.getElementById('resumeText').value = data.text;
      // Switch to paste tab to show the parsed text
      document.querySelector('[data-tab="pastePanel"]').click();
      showUploadStatus(`✓ ${file.name} parsed successfully`, false);
    }
  } catch {
    showUploadStatus('Upload failed. Please try again.', true);
  }
}

function showUploadStatus(msg, isError) {
  uploadStatus.textContent = msg;
  uploadStatus.style.color = isError ? '#ef4444' : '#10b981';
  uploadStatus.style.display = 'block';
}

/* ── Sample resume ────────────────────────────────────────────────────────── */
const SAMPLE_RESUME = `Jane Smith
jane.smith@email.com | linkedin.com/in/janesmith | github.com/janesmith
San Francisco, CA

EDUCATION
B.S. Computer Science, UC Berkeley, 2022
GPA: 3.7 / 4.0

EXPERIENCE
Software Engineer Intern — Google, Summer 2021
- Built a Python data pipeline processing 2M events/day using Apache Beam
- Reduced pipeline latency by 40% through query optimizations
- Wrote unit/integration tests achieving 95% coverage

Teaching Assistant — UC Berkeley CS 61A, 2020–2022
- Guided 30+ students weekly in Python, recursion, and data structures

PROJECTS
Personal Finance Tracker (React, Node.js, PostgreSQL)
- Full-stack web app for budget tracking with data visualization
- Deployed on AWS EC2 with CI/CD via GitHub Actions

ML Image Classifier (Python, TensorFlow, Keras)
- Fine-tuned ResNet50 on custom dataset, achieving 93% accuracy

SKILLS
Languages: Python, JavaScript/TypeScript, Java, SQL, Go (beginner)
Frameworks: React, Node.js, Flask, FastAPI, TensorFlow
Tools: AWS (EC2, S3, Lambda), Docker, Kubernetes, Git, PostgreSQL, MongoDB`;

document.getElementById('sampleLink').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('resumeText').value = SAMPLE_RESUME;
  document.querySelector('[data-tab="pastePanel"]').click();
});

/* ── Form submission ──────────────────────────────────────────────────────── */
const form = document.getElementById('searchForm');
const btnSearch = document.getElementById('btnSearch');

form.addEventListener('submit', async e => {
  e.preventDefault();
  await runSearch();
});

async function runSearch() {
  const resume = document.getElementById('resumeText').value.trim();
  if (!resume) {
    alert('Please paste your resume or upload a file.');
    return;
  }

  const payload = {
    resume,
    job_title:       document.getElementById('jobTitle').value.trim(),
    graduation_year: document.getElementById('graduationYear').value,
    country:         document.getElementById('country').value,
    city:            document.getElementById('city').value.trim(),
    visa_required:   document.getElementById('visaRequired').checked,
    job_type:        document.getElementById('jobType').value,
    salary_min:      document.getElementById('salaryMin').value,
  };

  showLoading();

  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || 'Search failed. Please try again.');
      return;
    }

    renderResults(data);
  } catch (err) {
    showError('Network error. Please check your connection and try again.');
  }
}

/* ── State helpers ────────────────────────────────────────────────────────── */
function showLoading() {
  document.getElementById('welcome').style.display  = 'none';
  document.getElementById('loading').style.display  = 'flex';
  document.getElementById('results').style.display  = 'none';
  btnSearch.disabled = true;
  btnSearch.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> Searching…';

  // Cycle through step messages
  const steps = [
    'Analyzing your resume with Claude AI…',
    'Generating smart search queries…',
    'Fetching live job listings from Adzuna…',
    'Scoring matches with AI…',
  ];
  let i = 0;
  const stepEl = document.getElementById('loadingStep');
  stepEl.textContent = steps[0];
  window._stepTimer = setInterval(() => {
    i = (i + 1) % steps.length;
    stepEl.textContent = steps[i];
  }, 2500);
}

function stopLoading() {
  clearInterval(window._stepTimer);
  document.getElementById('loading').style.display = 'none';
  btnSearch.disabled = false;
  btnSearch.innerHTML = '🔍 Search Jobs';
}

function showError(msg) {
  stopLoading();
  document.getElementById('welcome').style.display  = 'none';
  document.getElementById('results').style.display  = 'block';
  document.getElementById('results').innerHTML =
    `<div class="error-box">⚠️ ${escHtml(msg)}</div>`;
}

/* ── Render results ───────────────────────────────────────────────────────── */
function renderResults(data) {
  stopLoading();
  const { analysis, jobs, total } = data;

  let html = '';

  // API warning (no Adzuna keys)
  if (analysis._warning) {
    html += `<div class="warning-box">⚠️ ${escHtml(analysis._warning)}</div>`;
  }

  // Analysis card
  const levelColors = {
    entry: 'badge-warning', junior: 'badge-warning',
    mid: 'badge-level', senior: 'badge-level',
    lead: 'badge-exp', manager: 'badge-exp', director: 'badge-exp',
  };
  const levelBadge = levelColors[analysis.seniority_level] || 'badge-level';

  const skills = (analysis.key_skills || [])
    .map(s => `<span class="skill-tag">${escHtml(s)}</span>`)
    .join('');

  html += `
  <div class="analysis-card">
    <div class="analysis-header">
      <div class="analysis-title">👤 Your Profile Summary</div>
    </div>
    <p class="analysis-summary">${escHtml(analysis.candidate_summary || '')}</p>
    <div class="badge-row">
      <span class="badge ${levelBadge}">
        ${escHtml(capitalize(analysis.seniority_level || 'mid'))} Level
      </span>
      <span class="badge badge-exp">
        ${analysis.experience_years ?? '?'} yrs experience
      </span>
    </div>
    <div class="skills-list">${skills}</div>
    ${analysis.search_tips ? `
    <div class="tip-box">
      <strong>💡 Search tip</strong>
      ${escHtml(analysis.search_tips)}
    </div>` : ''}
  </div>`;

  // Jobs header
  html += `
  <div class="results-header">
    <div class="results-title">🔎 Job Matches</div>
    <div class="results-count">${total} result${total !== 1 ? 's' : ''} found</div>
  </div>`;

  if (!jobs || jobs.length === 0) {
    html += `
    <div class="empty-state">
      <div class="empty-state-icon">🗂️</div>
      <h3>No listings found</h3>
      <p>Try broadening your location, adjusting the job type, or lowering the salary filter.<br>
      Make sure your Adzuna API keys are configured in <code>.env</code>.</p>
    </div>`;
  } else {
    html += '<div class="jobs-list">';
    jobs.forEach(job => { html += renderJobCard(job); });
    html += '</div>';
  }

  const resultsEl = document.getElementById('results');
  resultsEl.innerHTML = html;
  resultsEl.style.display = 'block';
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderJobCard(job) {
  const score = job.match_score ?? 50;
  const matchClass = score >= 75 ? 'match-high' : score >= 50 ? 'match-mid' : 'match-low';

  const meta = [];
  if (job.location) meta.push(`📍 ${escHtml(job.location)}`);
  if (job.salary)   meta.push(`💰 ${escHtml(job.salary)}`);
  if (job.contract_time) meta.push(`🕐 ${escHtml(capitalize(job.contract_time.replace('_', ' ')))}`);
  if (job.created)  meta.push(`📅 ${escHtml(job.created)}`);
  if (job.category) meta.push(`🏷️ ${escHtml(job.category)}`);

  const metaHtml = meta
    .map(m => `<span class="job-meta-item">${m}</span>`)
    .join('');

  const reasonHtml = job.match_reason
    ? `<span class="match-reason">✓ ${escHtml(job.match_reason)}</span>`
    : '';

  const visaHtml = job.visa_note
    ? `<span class="visa-note">🛂 ${escHtml(job.visa_note)}</span>`
    : '';

  return `
  <div class="job-card">
    <div class="job-card-top">
      <div class="job-info">
        <div class="job-title">${escHtml(job.title)}</div>
        <div class="job-company">
          <span>${escHtml(job.company)}</span>
        </div>
      </div>
      <div class="match-badge ${matchClass}">
        ${score}
        <span class="score-label">MATCH</span>
      </div>
    </div>
    ${meta.length ? `<div class="job-meta">${metaHtml}</div>` : ''}
    ${job.description ? `<div class="job-description">${escHtml(job.description)}</div>` : ''}
    <div class="job-footer">
      <div style="display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0">
        ${reasonHtml}
        ${visaHtml}
      </div>
      <a href="${escAttr(job.url)}" target="_blank" rel="noopener" class="btn-apply">
        Apply ↗
      </a>
    </div>
  </div>`;
}

/* ── Utilities ────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s) {
  // Only allow http/https URLs
  const str = String(s);
  if (/^https?:\/\//i.test(str)) return escHtml(str);
  return '#';
}

function capitalize(s) {
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}
