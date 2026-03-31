import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import Fuse from 'fuse.js';
import JSZip from 'jszip';
import { put, del } from '@vercel/blob';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// ── Column definitions (fixed order) ─────────────────────────────────────────
const MATCH_COLS = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Provider Name (UAPOM)','Claim Type','Scheme','Amount Difference','Amount Tolerance Flag'];
const LINE_COLS  = ['Claim ID','Provider Name','Enrollee Name','Insurance No','Encounter Date (Long)','Item Name','Item Billed','Approved Amount','Difference (Billed - Approved)','Claim Status','Claim Item Comment','Match Status'];
const UC_COLS    = ['Claim ID','Enrollee Name','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status'];
const UU_COLS    = ['CLAIM ID','PATIENT NAME','MEMBER NUMBER','Transaction Date','AMOUNT','PROVIDER NAME','CLAIM TYPE','SCHEME'];
const NAME_COLS  = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Name Match Score (%)','Note'];
const PROV_COLS  = ['Provider Name','Match Status','Unique Claims','Line Items','Total Billed','Total Approved','Total Difference (Billed - Approved)'];

// ── Colors ────────────────────────────────────────────────────────────────────
const COLORS = {
  header:    { argb: 'FF1A2B3C' },
  perfect:   { argb: 'FFC6EFCE' },
  tolerance: { argb: 'FFFFEB9C' },
  notFound:  { argb: 'FFFFC7CE' },
  notFound2: { argb: 'FFFFD7D7' },
  nameMatch: { argb: 'FFDDEBF7' },
  alt:       { argb: 'FFF5F5F5' },
  white:     { argb: 'FFFFFFFF' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function longDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return String(d); }
}

function dateOnly(d) {
  if (!d) return '';
  try { return new Date(d).toISOString().slice(0, 10); }
  catch { return String(d); }
}

function styleSheet(ws, cols, rows, fillFn) {
  // Header
  const headerRow = ws.addRow(cols);
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: COLORS.header };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
  });
  headerRow.height = 30;

  // Data rows
  rows.forEach((row, ri) => {
    const dr = ws.addRow(cols.map(c => row[c] ?? ''));
    const fill = fillFn ? fillFn(row, ri) : (ri % 2 === 0 ? COLORS.alt : COLORS.white);
    dr.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: fill };
      cell.font = { name: 'Arial', size: 9 };
      cell.border = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
    });
  });

  // Column widths
  cols.forEach((col, i) => {
    const maxLen = Math.min(40, Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length)));
    ws.getColumn(i + 1).width = maxLen + 4;
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function matchFill(row) {
  if (row['Amount Tolerance Flag'] === 'YES') return COLORS.tolerance;
  return COLORS.perfect;
}

function lineFill(row, ri) {
  const s = row['Match Status'];
  if (s === 'Perfect Match') return COLORS.perfect;
  if (s === 'Name Match') return COLORS.nameMatch;
  return ri % 2 === 0 ? COLORS.notFound : COLORS.notFound2;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(request) {
  try {
    const { curacalUrl, uapomUrl } = await request.json();
    if (!curacalUrl || !uapomUrl) return Response.json({ error: 'Both file URLs required' }, { status: 400 });

    // Download files
    const [curacalRes, uapomRes] = await Promise.all([fetch(curacalUrl), fetch(uapomUrl)]);
    const curacalBuf = Buffer.from(await curacalRes.arrayBuffer());
    const uapomBuf   = Buffer.from(await uapomRes.arrayBuffer());

    // Parse files
    const curacalWb = XLSX.read(curacalBuf, { type: 'buffer', raw: false });
    const curacel   = XLSX.utils.sheet_to_json(curacalWb.Sheets[curacalWb.SheetNames[0]], { defval: '' });

    const uapomWb = XLSX.read(uapomBuf, { type: 'buffer', raw: false });
    const uapom   = XLSX.utils.sheet_to_json(uapomWb.Sheets[uapomWb.SheetNames[0]], { defval: '' });

    // Normalise
    curacel.forEach(r => {
      r._date    = dateOnly(r['Encounter Date']);
      r._member  = String(r['Insurance No'] ?? '').trim().toUpperCase();
      r._amount  = parseFloat(r['Amount Submitted']) || 0;
      r._name    = String(r['Enrollee Name'] ?? '').trim().toUpperCase();
      r._itemBilled   = parseFloat(r['Item Billed']) || 0;
      r._approved     = parseFloat(r['Approved Amount']) || 0;
      r['Date Display'] = longDate(r['Encounter Date']);
    });

    uapom.forEach(r => {
      r._date   = dateOnly(r['DATE'] || r['TRANSACTION'] || r['Date'] || '');
      r._member = String(r['MEMBER NUMBER'] ?? '').trim().toUpperCase();
      r._amount = parseFloat(r['AMOUNT']) || 0;
      r._name   = String(r['PATIENT NAME'] ?? '').trim().toUpperCase();
      r['Date Display'] = longDate(r['DATE'] || r['TRANSACTION'] || r['Date'] || '');
    });

    // Deduplicate Curacel to claim level for matching
    const claimMap = new Map();
    curacel.forEach(r => { if (!claimMap.has(r['id'])) claimMap.set(r['id'], r); });
    const claims = [...claimMap.values()];

    // Match
    const TOLERANCE = 2;
    const perfectRows = [], toleranceRows = [];
    const matchedClaimIds = new Set();
    const matchedUapomIdx = new Set();

    claims.forEach(crow => {
      uapom.forEach((urow, uidx) => {
        if (urow._member !== crow._member || urow._date !== crow._date) return;
        const diff = Math.abs(urow._amount - crow._amount);
        if (diff > TOLERANCE) return;
        const row = {
          'Claim ID': crow['id'],
          'Enrollee Name (Curacel)': crow['Enrollee Name'],
          'Insurance No': crow['Insurance No'],
          'Encounter Date': crow['Date Display'],
          'Amount Submitted': crow._amount,
          'Provider Name': crow['Provider Name'],
          'Claim Status': crow['Claim Status'],
          'Patient Name (UAPOM)': urow['PATIENT NAME'],
          'Member Number (UAPOM)': urow['MEMBER NUMBER'],
          'Transaction Date (UAPOM)': urow['Date Display'],
          'Amount (UAPOM)': urow._amount,
          'Provider Name (UAPOM)': urow['PROVIDER NAME'],
          'Claim Type': urow['CLAIM TYPE'],
          'Scheme': urow['SCHEME'],
          'Amount Difference': Math.round(diff * 100) / 100,
          'Amount Tolerance Flag': diff > 0 ? 'YES' : 'NO',
        };
        diff > 0 ? toleranceRows.push(row) : perfectRows.push(row);
        matchedClaimIds.add(crow['id']);
        matchedUapomIdx.add(uidx);
      });
    });

    const unmatchedClaims = claims.filter(r => !matchedClaimIds.has(r['id']));
    const unmatchedUapom  = uapom.filter((_, i) => !matchedUapomIdx.has(i));

    // Fuzzy name matching
    const fuse = new Fuse(unmatchedUapom, { keys: ['_name'], threshold: 0.4, includeScore: true });
    const nameRows = [];
    const fuzzyMatchedIds = new Set();

    unmatchedClaims.forEach(crow => {
      const results = fuse.search(crow._name);
      if (results.length > 0 && results[0].score < 0.4) {
        const urow = results[0].item;
        const score = Math.round((1 - results[0].score) * 100);
        nameRows.push({
          'Claim ID': crow['id'],
          'Enrollee Name (Curacel)': crow['Enrollee Name'],
          'Insurance No': crow['Insurance No'],
          'Encounter Date': crow['Date Display'],
          'Amount Submitted': crow._amount,
          'Provider Name': crow['Provider Name'],
          'Patient Name (UAPOM)': urow['PATIENT NAME'],
          'Member Number (UAPOM)': urow['MEMBER NUMBER'],
          'Transaction Date (UAPOM)': urow['Date Display'],
          'Amount (UAPOM)': urow._amount,
          'Name Match Score (%)': score,
          'Note': 'Name match only — verify manually',
        });
        fuzzyMatchedIds.add(crow['id']);
      }
    });

    // Line items
    const lineItems = curacel.map((r, ri) => ({
      'Claim ID': r['id'],
      'Provider Name': r['Provider Name'],
      'Enrollee Name': r['Enrollee Name'],
      'Insurance No': r['Insurance No'],
      'Encounter Date (Long)': r['Date Display'],
      'Item Name': r['Item Name'],
      'Item Billed': r._itemBilled,
      'Approved Amount': r._approved,
      'Difference (Billed - Approved)': r._itemBilled - r._approved,
      'Claim Status': r['Claim Status'],
      'Claim Item Comment': r['Claim Item Comment'],
      'Match Status': matchedClaimIds.has(r['id']) ? 'Perfect Match' : (fuzzyMatchedIds.has(r['id']) ? 'Name Match' : 'Not Found'),
    }));

    // Provider summary
    const provMap = new Map();
    lineItems.forEach(r => {
      const key = `${r['Provider Name']}|||${r['Match Status']}`;
      if (!provMap.has(key)) provMap.set(key, { 'Provider Name': r['Provider Name'], 'Match Status': r['Match Status'], claims: new Set(), lines: 0, billed: 0, approved: 0, diff: 0 });
      const p = provMap.get(key);
      p.claims.add(r['Claim ID']);
      p.lines++;
      p.billed += r['Item Billed'];
      p.approved += r['Approved Amount'];
      p.diff += r['Difference (Billed - Approved)'];
    });
    const provRows = [...provMap.values()].map(p => ({
      'Provider Name': p['Provider Name'],
      'Match Status': p['Match Status'],
      'Unique Claims': p.claims.size,
      'Line Items': p.lines,
      'Total Billed': Math.round(p.billed * 100) / 100,
      'Total Approved': Math.round(p.approved * 100) / 100,
      'Total Difference (Billed - Approved)': Math.round(p.diff * 100) / 100,
    }));

    // Date label
    const dates = curacel.map(r => r._date).filter(Boolean).sort();
    let dateLabel = 'Unknown';
    if (dates.length) {
      const min = dates[0], max = dates[dates.length - 1];
      const minD = new Date(min), maxD = new Date(max);
      dateLabel = minD.getMonth() === maxD.getMonth() && minD.getFullYear() === maxD.getFullYear()
        ? minD.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
        : `${minD.toLocaleDateString('en-GB', { month: 'short' })} - ${maxD.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
    }
    const safeLabel = dateLabel.replace(/\s+/g, '_').replace(/-/g, '_');

    // Unmatched display rows
    const ucRows = unmatchedClaims.map(r => ({
      'Claim ID': r['id'], 'Enrollee Name': r['Enrollee Name'], 'Insurance No': r['Insurance No'],
      'Encounter Date': r['Date Display'], 'Amount Submitted': r._amount,
      'Provider Name': r['Provider Name'], 'Claim Status': r['Claim Status'],
    }));
    const uuRows = unmatchedUapom.map(r => ({
      'CLAIM ID': r['CLAIM ID'], 'PATIENT NAME': r['PATIENT NAME'], 'MEMBER NUMBER': r['MEMBER NUMBER'],
      'Transaction Date': r['Date Display'], 'AMOUNT': r._amount,
      'PROVIDER NAME': r['PROVIDER NAME'], 'CLAIM TYPE': r['CLAIM TYPE'], 'SCHEME': r['SCHEME'],
    }));

    // Overall summary
    const totalBilled   = lineItems.reduce((s, r) => s + r['Item Billed'], 0);
    const totalApproved = lineItems.reduce((s, r) => s + r['Approved Amount'], 0);
    const overallRows = [
      { Metric: 'Total Curacel Claims', Value: claims.length },
      { Metric: 'Total UAPOM Records', Value: uapom.length },
      { Metric: 'Perfect Matches (Exact)', Value: perfectRows.length },
      { Metric: 'Tolerance Matches (≤2)', Value: toleranceRows.length },
      { Metric: 'Total Matched', Value: matchedClaimIds.size },
      { Metric: 'Unmatched Curacel Claims', Value: unmatchedClaims.length },
      { Metric: 'Unmatched UAPOM Records', Value: unmatchedUapom.length },
      { Metric: 'Name-based Possible Matches', Value: nameRows.length },
      { Metric: 'Total Line Items', Value: lineItems.length },
      { Metric: 'Total Amount Billed', Value: Math.round(totalBilled) },
      { Metric: 'Total Amount Approved', Value: Math.round(totalApproved) },
      { Metric: 'Total Difference (Billed - Approved)', Value: Math.round(totalBilled - totalApproved) },
    ];

    // Build master workbook
    const buildWorkbook = (sheets) => {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Claims Intel Dashboard';
      sheets.forEach(({ name, cols, rows, fillFn }) => {
        const ws = wb.addWorksheet(name);
        if (rows.length === 0 && !cols) { ws.addRow(['No data']); return; }
        styleSheet(ws, cols, rows, fillFn);
      });
      return wb;
    };

    const masterWb = buildWorkbook([
      { name: 'Overall Summary',       cols: ['Metric','Value'],  rows: overallRows },
      { name: 'Perfect Matches',       cols: MATCH_COLS, rows: perfectRows,   fillFn: () => COLORS.perfect },
      { name: 'Tolerance Matches (≤2)', cols: MATCH_COLS, rows: toleranceRows, fillFn: matchFill },
      { name: 'Unmatched - Curacel',   cols: UC_COLS,    rows: ucRows,        fillFn: () => COLORS.notFound },
      { name: 'Unmatched - UAPOM',     cols: UU_COLS,    rows: uuRows,        fillFn: () => COLORS.notFound },
      { name: 'Name-Based Matches',    cols: NAME_COLS,  rows: nameRows,      fillFn: () => COLORS.nameMatch },
      { name: 'Line Item Analysis',    cols: LINE_COLS,  rows: lineItems,     fillFn: lineFill },
      { name: 'Provider Summary',      cols: PROV_COLS,  rows: provRows },
    ]);

    const masterName = `UAPOM_Analysis_Master_${safeLabel}.xlsx`;
    const masterBuf  = await masterWb.xlsx.writeBuffer();

    // Build per-provider workbooks
    const providers = [...new Set(lineItems.map(r => r['Provider Name']).filter(Boolean))];
    const zip = new JSZip();
    zip.file(masterName, masterBuf);
    const provFolder = zip.folder('providers');

    for (const provider of providers) {
      const pLines   = lineItems.filter(r => r['Provider Name'] === provider);
      const pPerfect = perfectRows.filter(r => r['Provider Name'] === provider);
      const pTol     = toleranceRows.filter(r => r['Provider Name'] === provider);
      const pUc      = ucRows.filter(r => r['Provider Name'] === provider);
      const pName    = nameRows.filter(r => r['Provider Name'] === provider);
      const pMatches = [...pPerfect, ...pTol];

      const pSummary = [
        { Metric: 'Total Claims',    Value: new Set(pLines.map(r => r['Claim ID'])).size },
        { Metric: 'Perfect Matches', Value: pPerfect.length },
        { Metric: 'Tolerance Matches', Value: pTol.length },
        { Metric: 'Unmatched',       Value: pUc.length },
        { Metric: 'Name Matches',    Value: pName.length },
        { Metric: 'Line Items',      Value: pLines.length },
        { Metric: 'Total Billed',    Value: Math.round(pLines.reduce((s,r) => s + r['Item Billed'], 0)) },
        { Metric: 'Total Approved',  Value: Math.round(pLines.reduce((s,r) => s + r['Approved Amount'], 0)) },
        { Metric: 'Total Difference',Value: Math.round(pLines.reduce((s,r) => s + r['Difference (Billed - Approved)'], 0)) },
      ];

      const sheets = [{ name: 'Summary', cols: ['Metric','Value'], rows: pSummary }];
      if (pMatches.length) sheets.push({ name: 'Matches', cols: MATCH_COLS, rows: pMatches, fillFn: matchFill });
      if (pUc.length) sheets.push({ name: 'Unmatched', cols: UC_COLS, rows: pUc, fillFn: () => COLORS.notFound });
      if (pName.length) sheets.push({ name: 'Name Matches', cols: NAME_COLS, rows: pName, fillFn: () => COLORS.nameMatch });
      if (pLines.length) sheets.push({ name: 'Line Items', cols: LINE_COLS, rows: pLines, fillFn: lineFill });

      const pWb  = buildWorkbook(sheets);
      const pBuf = await pWb.xlsx.writeBuffer();
      const safe = provider.replace(/[^a-z0-9 \-_]/gi, '').trim().slice(0, 50);
      provFolder.file(`${safe}_${safeLabel}.xlsx`, pBuf);
    }

    const zipBuf  = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipName = `UAPOM_Analysis_${safeLabel}.zip`;

    // Upload results to Vercel Blob
    const [masterBlob, zipBlob] = await Promise.all([
      put(masterName, masterBuf, { access: 'public', token: process.env.BLOB_READ_WRITE_TOKEN }),
      put(zipName,    zipBuf,    { access: 'public', token: process.env.BLOB_READ_WRITE_TOKEN }),
    ]);

    // Cleanup input blobs
    try { await del([curacalUrl, uapomUrl], { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch {}

    return Response.json({
      success: true,
      date_label: dateLabel,
      master_name: masterName,
      zip_name: zipName,
      master_url: masterBlob.url,
      zip_url: zipBlob.url,
      perfect_matches: perfectRows.length,
      tolerance_matches: toleranceRows.length,
      unmatched_curacel: unmatchedClaims.length,
      unmatched_uapom: unmatchedUapom.length,
      name_matches: nameRows.length,
      providers: providers.length,
    });

  } catch (err) {
    console.error('[uapom-matcher]', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
