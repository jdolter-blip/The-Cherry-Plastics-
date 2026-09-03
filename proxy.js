const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MB_KEY = process.env.METABASE_API_KEY || '';
const PORT = process.env.PORT || 3000;

// Named queries — GET /data/:name bypasses Cloudflare bot challenge (no POST body)
const QUERIES = {
  ss: `SELECT d.account_executive,d.date::date AS date,SUM(CASE WHEN d.type='Loan' AND DATEDIFF(day,p.practice_go_live_date,d.date::date) BETWEEN 0 AND 60 THEN d.attributable_volume ELSE 0 END) AS volume,COUNT(DISTINCT CASE WHEN d.type='Go-Live' THEN d.sf_account_id END) AS go_lives FROM PROD.REVENUE_MARTS.SALES_DAILY_METRICS_DETAILS d LEFT JOIN PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p ON d.sf_account_id=p.sf_account_id WHERE d.industry_segment='Plastic & Cosmetic Surgery' AND d.date::date>='2026-05-01' AND d.date::date<'2026-11-01' GROUP BY 1,2 ORDER BY 1,2`,
  cm: `SELECT d.date::date AS date,SUM(CASE WHEN d.type='Loan' AND DATEDIFF(day,p.practice_go_live_date,d.date::date) BETWEEN 0 AND 60 THEN d.attributable_volume ELSE 0 END) AS volume,COUNT(DISTINCT CASE WHEN d.type='Go-Live' THEN d.sf_account_id END) AS go_lives FROM PROD.REVENUE_MARTS.SALES_DAILY_METRICS_DETAILS d LEFT JOIN PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p ON d.sf_account_id=p.sf_account_id WHERE d.industry_segment='Clinical Medicine' AND d.date::date>='2026-05-01' AND d.date::date<'2026-11-01' GROUP BY 1 ORDER BY 1`,
  cc: `SELECT d.account_executive,d.date::date AS date,SUM(CASE WHEN d.type='Loan' AND DATEDIFF(day,p.practice_go_live_date,d.date::date) BETWEEN 0 AND 60 THEN d.attributable_volume ELSE 0 END) AS volume,COUNT(DISTINCT CASE WHEN d.type='Go-Live' THEN d.sf_account_id END) AS go_lives FROM PROD.REVENUE_MARTS.SALES_DAILY_METRICS_DETAILS d LEFT JOIN PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p ON d.sf_account_id=p.sf_account_id WHERE d.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND d.date::date>='2026-05-01' AND d.date::date<'2026-11-01' GROUP BY 1,2 ORDER BY 1,2`,
  avgvol: `SELECT DATEADD('day',30,practice_go_live_date) AS graduated_date,account_executive,practice_first_30_healthy_gross_amount AS account_vol,COUNT(practice_first_30_healthy_gross_amount) OVER (PARTITION BY account_executive ORDER BY practice_go_live_date) AS graduated_count,AVG(practice_first_30_healthy_gross_amount) OVER (PARTITION BY account_executive ORDER BY practice_go_live_date) AS running_avg_vol FROM PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF WHERE DATEADD('day',30,practice_go_live_date)>='2026-05-01' AND DATEADD('day',30,practice_go_live_date)<CURRENT_DATE AND account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') ORDER BY account_executive,practice_go_live_date`,
  badge: `SELECT account_executive, gross_amount, funded_at_mt, merchant_name FROM (SELECT p.account_executive, al.gross_amount, CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt) AS funded_at_mt, p.merchant_name FROM PROD.CORE_MARTS.APPLICATIONS_LOANS_XF al JOIN prod.core_marts.practice_info_full_xf p ON al.merchant_id=p.cherry_merchant_id WHERE al.loan_status IN ('FUNDED','AWAITING_FUNDING') AND p.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt))>=DATEADD(day,-1,DATE(CONVERT_TIMEZONE('America/Denver',CURRENT_TIMESTAMP))) UNION ALL SELECT sla.name, sla.attributable_volume, CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt), sla.sf_account_name FROM PROD.REVENUE_MARTS.SALES_LOAN_ATTRIBUTION sla WHERE sla.merchant_type='Alle' AND sla.attribution_type='Owner' AND DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt))>=DATEADD(day,-1,DATE(CONVERT_TIMEZONE('America/Denver',CURRENT_TIMESTAMP))) AND sla.name IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATEDIFF(day,sla.go_live_date,DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt))) BETWEEN 0 AND 60) t ORDER BY funded_at_mt DESC LIMIT 1`,
  recent: `SELECT account_executive, gross_amount, funded_at_mt, sf_account_name, sf_account_id FROM (SELECT p.account_executive, al.gross_amount, TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt),'YYYY-MM-DD HH24:MI:SS') AS funded_at_mt, p.sf_account_name, p.sf_account_id FROM PROD.CORE_MARTS.APPLICATIONS_LOANS_XF al JOIN prod.core_marts.practice_info_full_xf p ON al.merchant_id=p.cherry_merchant_id WHERE al.loan_status IN ('FUNDED','AWAITING_FUNDING') AND p.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATEDIFF(day,p.practice_go_live_date,DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt))) BETWEEN 0 AND 60 UNION ALL SELECT sla.name, sla.attributable_volume, TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt),'YYYY-MM-DD HH24:MI:SS'), sla.sf_account_name, sla.sf_account_id FROM PROD.REVENUE_MARTS.SALES_LOAN_ATTRIBUTION sla WHERE sla.merchant_type='Alle' AND sla.attribution_type='Owner' AND sla.funded_at_pt>=DATEADD(day,-30,CURRENT_DATE) AND sla.name IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATEDIFF(day,sla.go_live_date,DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt))) BETWEEN 0 AND 60) t ORDER BY funded_at_mt DESC LIMIT 20`,
  checkouts: `WITH practices AS (SELECT cherry_merchant_id, practice_segment_start_date, sf_account_id FROM prod.core_marts.practice_info_full_xf) SELECT sm.account_executive, sm.onboarding_specialist, sm.merchant_name, TO_VARCHAR(practices.practice_segment_start_date,'YYYY-MM-DD') AS go_live_date, TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',src_cherry_loans.created_at_pt),'YYYY-MM-DD HH24:MI:SS') AS created_at_mt, CONCAT(b.first_name,' ',b.last_name) AS borrower_name, src_cherry_loans.purchase_amount, CURRENT_DATE-sm.GO_LIVE_DATE AS days_since, t.first_30_gross_amount, CONCAT('https://dashboard.withcherry.com/portal/originations/contracts/',src_cherry_loans.loan_id) AS dashboard_link, practices.sf_account_id FROM prep.cherry_data.src_cherry_loans INNER JOIN prep.core_staging.stg_merchants sm ON sm.merchant_id=src_cherry_loans.merchant_id LEFT JOIN practices ON sm.primary_merchant_id=practices.cherry_merchant_id LEFT JOIN prep.data_staging.merchant_loan_totals AS t ON sm.merchant_id=t.merchant_id LEFT JOIN raw.mariadb_fivetran_borrower_service_master.borrower b ON src_cherry_loans.borrower_id=b.id WHERE src_cherry_loans.is_demo=FALSE AND src_cherry_loans.loan_status NOT IN ('AWAITING_FUNDING','FUNDED','EXPIRED') AND src_cherry_loans.is_fivetran_deleted=FALSE AND sm.is_demo=FALSE AND sm.is_active=TRUE AND sm.DAYS_SINCE_GO_LIVE<=60 AND sm.DAYS_SINCE_GO_LIVE>=0 AND src_cherry_loans.created_at_pt::DATE>=CURRENT_DATE-INTERVAL '7 day' AND src_cherry_loans.created_at_pt::DATE<=CURRENT_DATE AND sm.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND src_cherry_loans.application_id NOT IN (SELECT a.application_id FROM prep.cherry_data.src_cherry_applications a WHERE a.is_fivetran_deleted=FALSE AND a.is_demo=FALSE AND a.application_id IN (SELECT DISTINCT l.application_id FROM prep.cherry_data.src_cherry_loans l WHERE l.is_demo=FALSE AND l.loan_status IN ('FUNDED','AWAITING_FUNDING') AND l.is_fivetran_deleted=FALSE)) ORDER BY sm.account_executive ASC, src_cherry_loans.purchase_amount DESC`,
  approvals: `WITH approvals AS (SELECT application_id,merchant_id,borrower_id,application_created_at_pt,application_status,loan_status,balance_available FROM prod.core_marts.applications_loans_xf WHERE application_created_at_pt IS NOT NULL AND DATE(application_created_at_pt)>=CURRENT_DATE-INTERVAL '7 day' AND application_status='APPROVED'), sent_checkouts AS (SELECT DISTINCT application_id FROM prod.core_marts.applications_loans_xf WHERE loan_status NOT IN ('AWAITING_FUNDING','FUNDED','EXPIRED')), practices AS (SELECT cherry_merchant_id,practice_segment_start_date,sf_account_id FROM prod.core_marts.practice_info_full_xf) SELECT sm.account_executive, sm.onboarding_specialist, TO_VARCHAR(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',a.application_created_at_pt),'YYYY-MM-DD HH24:MI:SS') AS approved_at_mt, CONCAT(b.first_name,' ',b.last_name) AS borrower_name, a.balance_available, sm.merchant_name, TO_VARCHAR(practices.practice_segment_start_date,'YYYY-MM-DD') AS go_live_date, CURRENT_DATE-sm.go_live_date AS days_since, t.first_30_gross_amount, CONCAT('https://dashboard.withcherry.com/portal/originations/applications/',a.application_id) AS application_link, practices.sf_account_id FROM approvals a JOIN prep.core_staging.stg_merchants sm ON a.merchant_id=sm.merchant_id LEFT JOIN practices ON sm.primary_merchant_id=practices.cherry_merchant_id LEFT JOIN prep.data_staging.merchant_loan_totals t ON a.merchant_id=t.merchant_id LEFT JOIN raw.mariadb_fivetran_borrower_service_master.borrower b ON a.borrower_id=b.id LEFT JOIN sent_checkouts s ON a.application_id=s.application_id WHERE s.application_id IS NULL AND DATEDIFF(minute,a.application_created_at_pt,CURRENT_TIMESTAMP)>15 AND sm.is_demo=FALSE AND sm.is_active=TRUE AND CURRENT_DATE-sm.go_live_date BETWEEN 0 AND 60 AND a.loan_status IS DISTINCT FROM 'FUNDED' AND a.loan_status IS DISTINCT FROM 'AWAITING_FUNDING' AND sm.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') ORDER BY sm.account_executive ASC, a.balance_available DESC`,
  recentgl: `SELECT p.account_executive, p.sf_account_name, TO_VARCHAR(p.practice_go_live_date,'YYYY-MM-DD') AS go_live_date, p.sf_account_id FROM PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p WHERE p.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND p.practice_go_live_date>=DATEADD(day,-30,CURRENT_DATE) ORDER BY p.practice_go_live_date DESC, p.sf_account_name LIMIT 20`,
  todayvol: `SELECT account_executive, SUM(vol) as vol FROM (SELECT p.account_executive, SUM(al.gross_amount) as vol FROM PROD.CORE_MARTS.APPLICATIONS_LOANS_XF al JOIN prod.core_marts.practice_info_full_xf p ON al.merchant_id=p.cherry_merchant_id WHERE al.loan_status IN ('FUNDED','AWAITING_FUNDING') AND DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt))=DATE(CONVERT_TIMEZONE('America/Denver',CURRENT_TIMESTAMP)) AND p.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATEDIFF(day,p.practice_go_live_date,DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',al.funded_at_pt))) BETWEEN 0 AND 60 GROUP BY 1 UNION ALL SELECT sla.name, SUM(sla.attributable_volume) FROM PROD.REVENUE_MARTS.SALES_LOAN_ATTRIBUTION sla WHERE sla.merchant_type='Alle' AND sla.attribution_type='Owner' AND DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt))=DATE(CONVERT_TIMEZONE('America/Denver',CURRENT_TIMESTAMP)) AND sla.name IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND DATEDIFF(day,sla.go_live_date,DATE(CONVERT_TIMEZONE('America/Los_Angeles','America/Denver',sla.funded_at_pt))) BETWEEN 0 AND 60 GROUP BY 1) t GROUP BY 1`,
  todaygl: `SELECT account_executive, COUNT(*) as gl FROM prod.core_marts.practice_info_full_xf WHERE practice_go_live_date=DATE(CONVERT_TIMEZONE('America/Denver',CURRENT_TIMESTAMP)) AND account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') GROUP BY 1`,
  activity: `SELECT activity_date::date AS date,name AS account_executive,SUM(CASE WHEN activity_type='Call' THEN 1 ELSE 0 END) AS calls,SUM(CASE WHEN activity_type='Demo' THEN 1 ELSE 0 END) AS demos,SUM(CASE WHEN activity_type='Text' THEN 1 ELSE 0 END) AS texts,SUM(CASE WHEN activity_type='Virtual Meeting' THEN 1 ELSE 0 END) AS virtual_meetings,SUM(CASE WHEN activity_type NOT IN ('Call','Demo','Text','Virtual Meeting','Email') THEN 1 ELSE 0 END) AS onboardings FROM PROD.REVENUE_MARTS.REVENUE_ACTIVITY_LEADERBOARD_DETAILS WHERE name IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND activity_date>='2026-08-01' AND activity_date<CURRENT_DATE AND (is_no_show IS NULL OR is_no_show=FALSE) GROUP BY 1,2 ORDER BY 2,1`,
  sstotal: `SELECT COUNT(DISTINCT CASE WHEN d.type='Go-Live' THEN d.sf_account_id END) AS total_gl,SUM(CASE WHEN d.type='Loan' AND DATEDIFF(day,p.practice_go_live_date,d.date::date) BETWEEN 0 AND 60 THEN d.attributable_volume ELSE 0 END) AS total_vol FROM PROD.REVENUE_MARTS.SALES_DAILY_METRICS_DETAILS d LEFT JOIN PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p ON d.sf_account_id=p.sf_account_id WHERE d.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND d.date::date>='2026-08-01' AND d.date::date<'2026-11-01'`,
  cctotal: `SELECT COUNT(DISTINCT CASE WHEN d.type='Go-Live' THEN d.sf_account_id END) AS total_gl,SUM(CASE WHEN d.type='Loan' AND DATEDIFF(day,p.practice_go_live_date,d.date::date) BETWEEN 0 AND 60 THEN d.attributable_volume ELSE 0 END) AS total_vol FROM PROD.REVENUE_MARTS.SALES_DAILY_METRICS_DETAILS d LEFT JOIN PROD.CORE_MARTS.PRACTICE_INFO_FULL_XF p ON d.sf_account_id=p.sf_account_id WHERE d.account_executive IN ('Nate Rosenberry','Rikki Herbel','Matthew Borgman','Morgan Thomas','Linda Chen','Kaylee Ross','Ava Lichter') AND d.date::date>='2026-08-01' AND d.date::date<'2026-11-01'`,
};

function mbRequest(reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'metabase.withcherry.com',
      path: reqPath, method,
      headers: { 'x-api-key': MB_KEY, 'Content-Type': 'application/json' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function runQuery(sql) {
  const payload = JSON.stringify({ database: 18, type: 'native', native: { query: sql } });
  return mbRequest('/api/dataset', 'POST', payload).then(r => r.body);
}

async function queryCard(cardId) {
  const r1 = await mbRequest(`/api/card/${cardId}/query`, 'POST', '{}');
  const d1 = JSON.parse(r1.body);
  if (r1.status === 202 && d1.job_id) {
    const jobId = d1.job_id;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const r2 = await mbRequest(`/api/async/result/${jobId}`, 'GET', null);
      if (r2.status === 200) {
        const d2 = JSON.parse(r2.body);
        if (d2.data) return JSON.stringify(d2);
      }
    }
    const r3 = await mbRequest(`/api/card/${cardId}/query/json`, 'POST', '{}');
    if (r3.status === 200) return r3.body;
  }
  return r1.body;
}

process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
process.on('uncaughtException',  (err) => console.error('uncaughtException', err));

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }

  if (req.url === '/' || req.url === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Named GET endpoints — bypass Cloudflare bot challenge (no POST body with SQL)
  // Strip query string (?t=...) before matching so cache-busting params don't break routing
  const urlPath = req.url.split('?')[0];
  const dataMatch = urlPath.match(/^\/data\/(\w+)$/);
  if (dataMatch && req.method === 'GET') {
    const name = dataMatch[1];
    const sql = QUERIES[name];
    if (!sql) { res.writeHead(404); return res.end('Unknown query'); }
    runQuery(sql).then(body => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    }).catch(err => {
      try { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); } catch {}
    });
    return;
  }

  // Legacy POST endpoint (kept for backward compat)
  if (req.url === '/proxy/query') {
    readBody(req).then(body => {
      let sql;
      try { sql = JSON.parse(body).sql; } catch { }
      if (!sql) { res.writeHead(400); return res.end('Missing sql'); }
      return runQuery(sql).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      });
    }).catch(err => {
      try { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); } catch {}
    });
    return;
  }

  const match = req.url.match(/^\/proxy\/card\/(\d+)\/query$/);
  if (!match) { res.writeHead(404); return res.end('Not found'); }

  queryCard(match[1]).then(result => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(result);
  }).catch(err => {
    try { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); } catch {}
  });
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
