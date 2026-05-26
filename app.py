import os
import io
import json
import requests
import anthropic
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv
from datetime import datetime

load_dotenv()

app = Flask(__name__)

_anthropic_client = None

def get_client():
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    return _anthropic_client


ADZUNA_APP_ID = os.getenv("ADZUNA_APP_ID", "")
ADZUNA_APP_KEY = os.getenv("ADZUNA_APP_KEY", "")

# Adzuna-supported country codes
COUNTRY_CODES = {
    "United States": "us",
    "United Kingdom": "gb",
    "Australia": "au",
    "Canada": "ca",
    "Germany": "de",
    "France": "fr",
    "Netherlands": "nl",
    "Austria": "at",
    "Brazil": "br",
    "India": "in",
    "Italy": "it",
    "Mexico": "mx",
    "New Zealand": "nz",
    "Poland": "pl",
    "South Africa": "za",
}

CURRENT_YEAR = datetime.now().year


@app.route("/")
def index():
    return render_template(
        "index.html",
        countries=list(COUNTRY_CODES.keys()),
        current_year=CURRENT_YEAR,
    )


@app.route("/parse-resume", methods=["POST"])
def parse_resume():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f = request.files["file"]
    name = (f.filename or "").lower()
    data = f.read()

    try:
        if name.endswith(".pdf"):
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(data))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        elif name.endswith(".docx"):
            from docx import Document
            doc = Document(io.BytesIO(data))
            text = "\n".join(p.text for p in doc.paragraphs)
        elif name.endswith(".txt"):
            text = data.decode("utf-8", errors="replace")
        else:
            return jsonify({"error": "Unsupported file type. Use PDF, DOCX, or TXT."}), 400

        return jsonify({"text": text.strip()})
    except Exception as e:
        return jsonify({"error": f"Failed to parse file: {e}"}), 500


@app.route("/search", methods=["POST"])
def search():
    body = request.json or {}
    resume = (body.get("resume") or "").strip()
    job_title = (body.get("job_title") or "").strip()
    graduation_year = body.get("graduation_year", "")
    country = body.get("country", "United States")
    city = (body.get("city") or "").strip()
    visa_required = bool(body.get("visa_required", False))
    job_type = body.get("job_type", "any")
    salary_min = body.get("salary_min", "")

    if not resume:
        return jsonify({"error": "Resume text is required"}), 400

    # Step 1 — Claude analyzes the resume
    try:
        analysis = _analyze_resume(
            resume, job_title, graduation_year, visa_required, country
        )
    except Exception as e:
        return jsonify({"error": f"Resume analysis failed: {e}"}), 500

    # Step 2 — Fetch jobs from Adzuna
    jobs = []
    if ADZUNA_APP_ID and ADZUNA_APP_KEY:
        country_code = COUNTRY_CODES.get(country, "us")
        jobs = _search_adzuna(
            analysis["search_keywords"], country_code, city, job_type, salary_min
        )
        # Supplement with alternative title if results are thin
        if len(jobs) < 5 and analysis.get("alternative_titles"):
            extra = _search_adzuna(
                analysis["alternative_titles"][0],
                country_code,
                city,
                job_type,
                salary_min,
            )
            seen = {j["id"] for j in jobs}
            jobs += [j for j in extra if j["id"] not in seen]
    else:
        analysis["_warning"] = (
            "Adzuna API keys not configured — job listings unavailable. "
            "Set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env to enable live search."
        )

    # Step 3 — Claude scores each job against the resume
    if jobs:
        jobs = _score_jobs(jobs, analysis, visa_required)

    return jsonify({"analysis": analysis, "jobs": jobs, "total": len(jobs)})


# ── Claude helpers ───────────────────────────────────────────────────────────

_ANALYSIS_SYSTEM = (
    "You are a professional career advisor and resume analyst. "
    "Extract key information and provide actionable job search guidance. "
    "Always respond with valid JSON only — no markdown, no additional text."
)


def _analyze_resume(resume, job_title, graduation_year, visa_required, country):
    exp_note = ""
    if graduation_year:
        try:
            exp_note = f" ({CURRENT_YEAR - int(graduation_year)} years since graduation)"
        except ValueError:
            pass

    prompt = f"""Analyze this candidate's resume and job search criteria.

RESUME:
{resume[:4500]}

JOB SEARCH CRITERIA:
- Target role: {job_title or "Not specified — infer the best-fit role from the resume"}
- Graduation year: {graduation_year}{exp_note}
- Target country: {country}
- Visa sponsorship required: {"Yes" if visa_required else "No"}

Return a JSON object with exactly these keys:
{{
  "candidate_summary": "2-3 sentences describing background and value proposition",
  "key_skills": ["skill1", "skill2", "skill3", "skill4", "skill5"],
  "experience_years": <integer — estimated total years of relevant experience>,
  "seniority_level": "<entry | junior | mid | senior | lead | manager | director>",
  "search_keywords": "<3-5 word Adzuna search query, e.g. 'software engineer python machine learning'>",
  "alternative_titles": ["alternative job title 1", "alternative job title 2"],
  "strengths": ["key strength 1", "key strength 2", "key strength 3"],
  "search_tips": "One concrete tip tailored to this candidate's situation"
}}"""

    client = get_client()
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=_ANALYSIS_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = resp.content[0].text.strip()
    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.rsplit("```", 1)[0].strip()

    return json.loads(raw)


def _score_jobs(jobs, analysis, visa_required):
    summaries = []
    for i, j in enumerate(jobs[:15]):
        summaries.append(
            f"{i+1}. [{j['title']}] at [{j['company']}], {j['location']}\n"
            f"   {j['description'][:280]}"
        )

    prompt = f"""Score each job's fit for this candidate (0-100).

CANDIDATE:
- {analysis['candidate_summary']}
- Skills: {', '.join(analysis['key_skills'][:8])}
- Level: {analysis['seniority_level']} ({analysis['experience_years']} yrs exp)
- Needs visa sponsorship: {"Yes" if visa_required else "No"}

JOBS:
{chr(10).join(summaries)}

Return JSON only:
{{
  "matches": [
    {{
      "job_number": 1,
      "score": 85,
      "reason": "One sentence explaining fit",
      "visa_note": "mentions sponsorship" or null
    }}
  ]
}}

Score based on: skill alignment (60%), seniority fit (25%), visa mention if needed (15%).
If visa_required is True and the description does NOT mention sponsorship, reduce score by 10 points."""

    client = get_client()
    try:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        if "```" in raw:
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()

        data = json.loads(raw)
        match_map = {m["job_number"] - 1: m for m in data["matches"]}

        for i, job in enumerate(jobs):
            m = match_map.get(i, {})
            job["match_score"] = m.get("score", 50)
            job["match_reason"] = m.get("reason", "")
            job["visa_note"] = m.get("visa_note")

        jobs.sort(key=lambda x: x.get("match_score", 0), reverse=True)

    except Exception as e:
        print(f"Scoring error: {e}")
        for job in jobs:
            job.setdefault("match_score", 50)
            job.setdefault("match_reason", "")
            job.setdefault("visa_note", None)

    return jobs


# ── Adzuna helper ────────────────────────────────────────────────────────────

def _search_adzuna(keywords, country_code, location, job_type, salary_min):
    url = f"https://api.adzuna.com/v1/api/jobs/{country_code}/search/1"
    params = {
        "app_id": ADZUNA_APP_ID,
        "app_key": ADZUNA_APP_KEY,
        "results_per_page": 15,
        "what": keywords,
        "sort_by": "relevance",
    }

    if location:
        params["where"] = location
    if job_type == "full_time":
        params["full_time"] = 1
    elif job_type == "part_time":
        params["part_time"] = 1
    elif job_type == "contract":
        params["contract"] = 1
    elif job_type == "permanent":
        params["permanent"] = 1

    if salary_min:
        try:
            params["salary_min"] = int(salary_min)
        except ValueError:
            pass

    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        results = resp.json().get("results", [])

        jobs = []
        for j in results:
            sal_min = j.get("salary_min")
            sal_max = j.get("salary_max")
            if sal_min and sal_max:
                salary = f"${sal_min:,.0f} – ${sal_max:,.0f}"
            elif sal_min:
                salary = f"${sal_min:,.0f}+"
            else:
                salary = None

            jobs.append(
                {
                    "id": j.get("id", ""),
                    "title": j.get("title", "Unknown Title"),
                    "company": j.get("company", {}).get("display_name", "Unknown"),
                    "location": j.get("location", {}).get("display_name", ""),
                    "salary": salary,
                    "description": (j.get("description") or "")[:600],
                    "url": j.get("redirect_url", "#"),
                    "created": (j.get("created") or "")[:10],
                    "category": j.get("category", {}).get("label", ""),
                    "contract_time": j.get("contract_time", ""),
                }
            )
        return jobs

    except requests.RequestException as e:
        print(f"Adzuna error: {e}")
        return []


if __name__ == "__main__":
    app.run(debug=True, port=5000)
