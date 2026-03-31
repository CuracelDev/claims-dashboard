import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { put } from '@vercel/blob';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

function styleSheet(ws, cols, rows, fillFn) {
  const hr = ws.addRow(cols);
  hr.eachCell(c => {
    c.fill = { type:'pattern', pattern:'solid', fgColor: COLORS.header };
    c.font = { bold:true, color:{argb:'FFFFFFFF'}, name:'Arial', size:10 };
    c.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
    c.border = { top:{style:'thin',color:{argb:'FFD0D0D0'}}, bottom:{style:'thin',color:{argb:'FFD0D0D0'}}, left:{style:'thin',color:{argb:'FFD0D0D0'}}, right:{style:'thin',color:{argb:'FFD0D0D0'}} };
  });
  hr.height = 30;
  rows.forEach((row, ri) => {
    const dr = ws.addRow(cols.map(c => row[c] ?? ''));
    const fill = fillFn ? fillFn(row, ri) : (ri%2===0 ? COLORS.alt : COLORS.white);
    dr.eachCell(c => {
      c.fill = { type:'pattern', pattern:'solid', fgColor: fill };
      c.font = { name:'Arial', size:9 };
      c.border = { top:{style:'thin',color:{argb:'FFD0D0D0'}}, bottom:{style:'thin',color:{argb:'FFD0D0D0'}}, left:{style:'thin',color:{argb:'FFD0D0D0'}}, right:{style:'thin',color:{argb:'FFD0D0D0'}} };
    });
  });
  cols.forEach((col, i) => {
    const ml = Math.min(40, Math.max(col.length, ...rows.map(r => String(r[col]??'').length)));
    ws.getColumn(i+1).width = ml+4;
  });
  ws.views = [{ state:'frozen', ySplit:1 }];
}

function matchFill(row) {
  return row['Amount Tolerance Flag']==='YES' ? COLORS.tolerance : COLORS.perfect;
}
function lineFill(row, ri) {
  const s = row['Match Status'];
  if (s==='Perfect Match') return COLORS.perfect;
  if (s==='Name Match') return COLORS.nameMatch;
  return ri%2===0 ? COLORS.notFound : COLORS.notFound2;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { perfectRows=[], toleranceRows=[], ucRows=[], uuRows=[], nameRows=[], lineItems=[], provRows=[], overallRows=[], dateLabel='Unknown', safeLabel='Unknown' } = body;

    const MATCH_COLS = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Provider Name (UAPOM)','Claim Type','Scheme','Amount Difference','Amount Tolerance Flag'];
    const LINE_COLS  = ['Claim ID','Provider Name','Enrollee Name','Insurance No','Encounter Date (Long)','Item Name','Item Billed','Approved Amount','Difference (Billed - Approved)','Claim Status','Claim Item Comment','Match Status'];
    const UC_COLS    = ['Claim ID','Enrollee Name','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status'];
    const UU_COLS    = ['CLAIM ID','PATIENT NAME','MEMBER NUMBER','Transaction Date','AMOUNT','PROVIDER NAME','CLAIM TYPE','SCHEME'];
    const NAME_COLS  = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Name Match Score (%)','Note'];
    const PROV_COLS  = ['Provider Name','Match Status','Unique Claims','Line Items','Total Billed','Total Approved','Total Difference (Billed - Approved)'];

    const buildWb = (sheets) => {
      const wb = new ExcelJS.Workbook();
      sheets.forEach(({ name, cols, rows, fillFn }) => {
        const ws = wb.addWorksheet(name);
        if (!rows.length) { ws.addRow(['No data']); return; }
        styleSheet(ws, cols, rows, fillFn);
      });
      return wb;
    };

    const ts = new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');
    const label = `${safeLabel}_${ts}`;
    const masterName = `UAPOM_Analysis_Master_${label}.xlsx`;
    const zipName    = `UAPOM_Analysis_${label}.zip`;

    const masterWb = buildWb([
      { name:'Overall Summary',        cols:['Metric','Value'],  rows:overallRows },
      { name:'Perfect Matches',        cols:MATCH_COLS, rows:perfectRows,   fillFn:()=>COLORS.perfect },
      { name:'Tolerance Matches (≤2)', cols:MATCH_COLS, rows:toleranceRows, fillFn:matchFill },
      { name:'Unmatched - Curacel',    cols:UC_COLS,    rows:ucRows,        fillFn:()=>COLORS.notFound },
      { name:'Unmatched - UAPOM',      cols:UU_COLS,    rows:uuRows,        fillFn:()=>COLORS.notFound },
      { name:'Name-Based Matches',     cols:NAME_COLS,  rows:nameRows,      fillFn:()=>COLORS.nameMatch },
      { name:'Line Item Analysis',     cols:LINE_COLS,  rows:lineItems,     fillFn:lineFill },
      { name:'Provider Summary',       cols:PROV_COLS,  rows:provRows },
    ]);

    const masterBuf = await masterWb.xlsx.writeBuffer();

    // Per-provider files
    const providers = [...new Set(lineItems.map(r => r['Provider Name']).filter(Boolean))];
    const zip = new JSZip();
    zip.file(masterName, masterBuf);
    const pf = zip.folder('providers');

    for (const provider of providers) {
      const pLines   = lineItems.filter(r => r['Provider Name']===provider);
      const pPerfect = perfectRows.filter(r => r['Provider Name']===provider);
      const pTol     = toleranceRows.filter(r => r['Provider Name']===provider);
      const pUc      = ucRows.filter(r => r['Provider Name']===provider);
      const pName    = nameRows.filter(r => r['Provider Name']===provider);
      const pSummary = [
        {Metric:'Total Claims',Value:new Set(pLines.map(r=>r['Claim ID'])).size},
        {Metric:'Perfect Matches',Value:pPerfect.length},
        {Metric:'Tolerance Matches',Value:pTol.length},
        {Metric:'Unmatched',Value:pUc.length},
        {Metric:'Name Matches',Value:pName.length},
        {Metric:'Line Items',Value:pLines.length},
        {Metric:'Total Billed',Value:Math.round(pLines.reduce((s,r)=>s+r['Item Billed'],0))},
        {Metric:'Total Approved',Value:Math.round(pLines.reduce((s,r)=>s+r['Approved Amount'],0))},
        {Metric:'Total Difference',Value:Math.round(pLines.reduce((s,r)=>s+r['Difference (Billed - Approved)'],0))},
      ];
      const sheets = [{name:'Summary',cols:['Metric','Value'],rows:pSummary}];
      if (pPerfect.length||pTol.length) sheets.push({name:'Matches',cols:MATCH_COLS,rows:[...pPerfect,...pTol],fillFn:matchFill});
      if (pUc.length) sheets.push({name:'Unmatched',cols:UC_COLS,rows:pUc,fillFn:()=>COLORS.notFound});
      if (pName.length) sheets.push({name:'Name Matches',cols:NAME_COLS,rows:pName,fillFn:()=>COLORS.nameMatch});
      if (pLines.length) sheets.push({name:'Line Items',cols:LINE_COLS,rows:pLines,fillFn:lineFill});
      const pWb  = buildWb(sheets);
      const pBuf = await pWb.xlsx.writeBuffer();
      const safe = provider.replace(/[^a-z0-9 \-_]/gi,'').trim().slice(0,50);
      pf.file(`${safe}_${label}.xlsx`, pBuf);
    }

    const zipBuf = await zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' });

    const [masterBlob, zipBlob] = await Promise.all([
      put(masterName, masterBuf, { access:'public', token:process.env.BLOB_READ_WRITE_TOKEN, allowOverwrite:true }),
      put(zipName,    zipBuf,    { access:'public', token:process.env.BLOB_READ_WRITE_TOKEN, allowOverwrite:true }),
    ]);

    return Response.json({
      success: true,
      date_label: dateLabel,
      master_name: masterName,
      zip_name: zipName,
      master_url: masterBlob.url,
      zip_url: zipBlob.url,
      perfect_matches: perfectRows.length,
      tolerance_matches: toleranceRows.length,
      unmatched_curacel: ucRows.length,
      unmatched_uapom: uuRows.length,
      name_matches: nameRows.length,
      providers: providers.length,
    });

  } catch (err) {
    console.error('[generate]', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
