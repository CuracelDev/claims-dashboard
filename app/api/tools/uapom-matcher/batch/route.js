// v3 - clean rewrite
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const execAsync = promisify(exec);
const BASE = '/tmp/uapom-matcher';

const MATCH_COLS = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Provider Name (UAPOM)','Claim Type','Scheme','Amount Difference','Amount Tolerance Flag'];
const LINE_COLS = ['Claim ID','Provider Name','Enrollee Name','Insurance No','Encounter Date','Encounter Date (Long)','Item Name','Item Billed','Approved Amount','Difference (Billed - Approved)','Claim Status','Claim Item Comment','Match Status'];
const UNMATCHED_C_COLS = ['Claim ID','Enrollee Name','Insurance No','Encounter Date','Amount Submitted','Provider Name','Claim Status'];
const UNMATCHED_U_COLS = ['CLAIM ID','PATIENT NAME','MEMBER NUMBER','Transaction Date','AMOUNT','PROVIDER NAME','CLAIM TYPE','SCHEME'];
const NAME_COLS = ['Claim ID','Enrollee Name (Curacel)','Insurance No','Encounter Date','Amount Submitted','Provider Name','Patient Name (UAPOM)','Member Number (UAPOM)','Transaction Date (UAPOM)','Amount (UAPOM)','Name Match Score (%)','Note'];
const PROV_COLS = ['Provider Name','Match Status','Unique Claims','Line Items','Total Billed','Total Approved','Total Difference (Billed - Approved)'];

function makeBatchScript(curacalPath, uapomPath, sessionDir, batchNum) {
  return [
    'import pandas as pd, numpy as np, os, sys, json, warnings',
    'from openpyxl import Workbook',
    'from openpyxl.styles import PatternFill, Font, Alignment, Border, Side',
    'from openpyxl.utils import get_column_letter',
    'from fuzzywuzzy import fuzz',
    'warnings.filterwarnings("ignore")',
    `MATCH_COLS = ${JSON.stringify(MATCH_COLS)}`,
    `LINE_COLS = ${JSON.stringify(LINE_COLS)}`,
    `UNMATCHED_C_COLS = ${JSON.stringify(UNMATCHED_C_COLS)}`,
    `UNMATCHED_U_COLS = ${JSON.stringify(UNMATCHED_U_COLS)}`,
    `NAME_COLS = ${JSON.stringify(NAME_COLS)}`,
    `PROV_COLS = ${JSON.stringify(PROV_COLS)}`,
    'def ensure_cols(df, cols):',
    '    for c in cols:',
    '        if c not in df.columns: df[c] = None',
    '    return df[cols]',
    `uapom = pd.read_excel(r"${uapomPath}")`,
    `curacel = pd.read_csv(r"${curacalPath}", low_memory=False)`,
    'uapom["date_only"] = pd.to_datetime(uapom["TRANSACTION"]).dt.date',
    'curacel["date_only"] = pd.to_datetime(curacel["Encounter Date"]).dt.date',
    'def long_date(d):',
    '    try: return pd.to_datetime(d).strftime("%d %B %Y")',
    '    except: return str(d)',
    'uapom["Date Display"] = uapom["TRANSACTION"].apply(long_date)',
    'curacel["Date Display"] = curacel["Encounter Date"].apply(long_date)',
    'uapom["member_key"] = uapom["MEMBER NUMBER"].astype(str).str.strip().str.upper()',
    'curacel["member_key"] = curacel["Insurance No"].astype(str).str.strip().str.upper()',
    'uapom["AMOUNT"] = pd.to_numeric(uapom["AMOUNT"], errors="coerce").fillna(0)',
    'curacel["Amount Submitted"] = pd.to_numeric(curacel["Amount Submitted"], errors="coerce").fillna(0)',
    'curacel["Item Billed"] = pd.to_numeric(curacel["Item Billed"], errors="coerce").fillna(0)',
    'curacel["Approved Amount"] = pd.to_numeric(curacel["Approved Amount"], errors="coerce").fillna(0)',
    'uapom["name_clean"] = uapom["PATIENT NAME"].astype(str).str.strip().str.upper()',
    'curacel["name_clean"] = curacel["Enrollee Name"].astype(str).str.strip().str.upper()',
    'claim_cols = ["id","member_key","date_only","Date Display","Amount Submitted","Enrollee Name","name_clean","Provider Name","Insurance No","Encounter Date","Amount Approved","Claim Status"]',
    'claim_level = curacel.drop_duplicates(subset=["id"])[claim_cols].copy()',
    'TOLERANCE = 2',
    'perfect_rows, tolerance_rows = [], []',
    'uapom_matched_idx, claim_matched_ids = set(), set()',
    'for _, crow in claim_level.iterrows():',
    '    cand = uapom[(uapom["member_key"]==crow["member_key"])&(uapom["date_only"]==crow["date_only"])]',
    '    if cand.empty: continue',
    '    for uidx, urow in cand.iterrows():',
    '        diff = abs(urow["AMOUNT"] - crow["Amount Submitted"])',
    '        if diff <= TOLERANCE:',
    '            row = {"Claim ID":crow["id"],"Enrollee Name (Curacel)":crow["Enrollee Name"],"Insurance No":crow["Insurance No"],"Encounter Date":crow["Date Display"],"Amount Submitted":crow["Amount Submitted"],"Provider Name":crow["Provider Name"],"Claim Status":crow["Claim Status"],"Patient Name (UAPOM)":urow["PATIENT NAME"],"Member Number (UAPOM)":urow["MEMBER NUMBER"],"Transaction Date (UAPOM)":urow["Date Display"],"Amount (UAPOM)":urow["AMOUNT"],"Provider Name (UAPOM)":urow["PROVIDER NAME"],"Claim Type":urow["CLAIM TYPE"],"Scheme":urow["SCHEME"],"Amount Difference":round(diff,2),"Amount Tolerance Flag":"YES" if diff>0 else "NO"}',
    '            (tolerance_rows if diff>0 else perfect_rows).append(row)',
    '            uapom_matched_idx.add(uidx)',
    '            claim_matched_ids.add(crow["id"])',
    'perfect_df = pd.DataFrame(perfect_rows) if perfect_rows else pd.DataFrame(columns=MATCH_COLS)',
    'tolerance_df = pd.DataFrame(tolerance_rows) if tolerance_rows else pd.DataFrame(columns=MATCH_COLS)',
    'all_matched_ids = claim_matched_ids.copy()',
    'unmatched_curacel = claim_level[~claim_level["id"].isin(all_matched_ids)].copy()',
    'unmatched_uapom = uapom[~uapom.index.isin(uapom_matched_idx)].copy()',
    'name_match_rows, fuzzy_matched_claim_ids = [], set()',
    'for _, crow in unmatched_curacel.iterrows():',
    '    best_score, best_urow = 0, None',
    '    cands = unmatched_uapom[(unmatched_uapom["member_key"]==crow["member_key"])|(unmatched_uapom["date_only"]==crow["date_only"])]',
    '    for _, urow in cands.iterrows():',
    '        score = fuzz.token_sort_ratio(crow["name_clean"], urow["name_clean"])',
    '        if score > best_score: best_score, best_urow = score, urow',
    '    if best_score >= 60 and best_urow is not None:',
    '        name_match_rows.append({"Claim ID":crow["id"],"Enrollee Name (Curacel)":crow["Enrollee Name"],"Insurance No":crow["Insurance No"],"Encounter Date":crow["Date Display"],"Amount Submitted":crow["Amount Submitted"],"Provider Name":crow["Provider Name"],"Patient Name (UAPOM)":best_urow["PATIENT NAME"],"Member Number (UAPOM)":best_urow["MEMBER NUMBER"],"Transaction Date (UAPOM)":best_urow["Date Display"],"Amount (UAPOM)":best_urow["AMOUNT"],"Name Match Score (%)":best_score,"Note":"Name match only - verify manually"})',
    '        fuzzy_matched_claim_ids.add(crow["id"])',
    'name_df = pd.DataFrame(name_match_rows) if name_match_rows else pd.DataFrame(columns=NAME_COLS)',
    'line_items = curacel[["id","Provider Name","Enrollee Name","Insurance No","Encounter Date","Date Display","Item Name","Item Billed","Approved Amount","Claim Status","Claim Item Comment"]].copy()',
    'line_items["Difference (Billed - Approved)"] = line_items["Item Billed"] - line_items["Approved Amount"]',
    'line_items["Match Status"] = line_items["id"].apply(lambda x: "Perfect Match" if x in all_matched_ids else ("Name Match" if x in fuzzy_matched_claim_ids else "Not Found"))',
    'line_items = line_items.rename(columns={"id":"Claim ID","Date Display":"Encounter Date (Long)"})',
    'prov_summary = line_items.groupby(["Provider Name","Match Status"]).agg(Unique_Claims=("Claim ID","nunique"),Line_Items=("Claim ID","count"),Total_Billed=("Item Billed","sum"),Total_Approved=("Approved Amount","sum"),Total_Difference=("Difference (Billed - Approved)","sum")).reset_index()',
    'prov_summary.columns = PROV_COLS',
    'try:',
    '    all_dates = pd.to_datetime(curacel["Encounter Date"], errors="coerce").dropna()',
    '    min_d, max_d = all_dates.min(), all_dates.max()',
    '    date_label = min_d.strftime("%b %Y") if min_d.month==max_d.month and min_d.year==max_d.year else f"{min_d.strftime(\"%b\")} - {max_d.strftime(\"%b %Y\")}"',
    'except: date_label = "Unknown"',
    'perfect_df = ensure_cols(perfect_df, MATCH_COLS)',
    'tolerance_df = ensure_cols(tolerance_df, MATCH_COLS)',
    'uc = unmatched_curacel.rename(columns={"id":"Claim ID","Date Display":"Encounter Date"})',
    'if "Claim ID" not in uc.columns: uc["Claim ID"] = None',
    'uc = ensure_cols(uc, UNMATCHED_C_COLS)',
    'uu = unmatched_uapom[["CLAIM ID","PATIENT NAME","MEMBER NUMBER","Date Display","AMOUNT","PROVIDER NAME","CLAIM TYPE","SCHEME"]].rename(columns={"Date Display":"Transaction Date"})',
    'uu = ensure_cols(uu, UNMATCHED_U_COLS)',
    'name_df = ensure_cols(name_df, NAME_COLS)',
    'line_items = ensure_cols(line_items, LINE_COLS)',
    'prov_summary = ensure_cols(prov_summary, PROV_COLS)',
    `perfect_df.to_parquet(r"${sessionDir}/batch_${batchNum}_perfect.parquet", index=False)`,
    `tolerance_df.to_parquet(r"${sessionDir}/batch_${batchNum}_tolerance.parquet", index=False)`,
    `uc.to_parquet(r"${sessionDir}/batch_${batchNum}_unmatched_c.parquet", index=False)`,
    `uu.to_parquet(r"${sessionDir}/batch_${batchNum}_unmatched_u.parquet", index=False)`,
    `name_df.to_parquet(r"${sessionDir}/batch_${batchNum}_name.parquet", index=False)`,
    `line_items.to_parquet(r"${sessionDir}/batch_${batchNum}_lines.parquet", index=False)`,
    `prov_summary.to_parquet(r"${sessionDir}/batch_${batchNum}_prov.parquet", index=False)`,
    `batch_result = {"batch": ${batchNum}, "date_label": date_label, "perfect_matches": len(perfect_df), "tolerance_matches": len(tolerance_df), "unmatched_curacel": len(unmatched_curacel), "unmatched_uapom": len(unmatched_uapom), "name_matches": len(name_df), "providers": int(curacel["Provider Name"].nunique())}`,
    `with open(r"${sessionDir}/batch_${batchNum}_result.json", "w") as f: json.dump(batch_result, f)`,
    'print(json.dumps(batch_result))',
  ].join('\n');
}

function makeFinalizeScript(sessionDir, outDir) {
  return [
    'import pandas as pd, numpy as np, os, json, glob, warnings',
    'from openpyxl import Workbook',
    'from openpyxl.styles import PatternFill, Font, Alignment, Border, Side',
    'from openpyxl.utils import get_column_letter',
    'import zipfile',
    'warnings.filterwarnings("ignore")',
    `MATCH_COLS = ${JSON.stringify(MATCH_COLS)}`,
    `LINE_COLS = ${JSON.stringify(LINE_COLS)}`,
    `UNMATCHED_C_COLS = ${JSON.stringify(UNMATCHED_C_COLS)}`,
    `UNMATCHED_U_COLS = ${JSON.stringify(UNMATCHED_U_COLS)}`,
    `NAME_COLS = ${JSON.stringify(NAME_COLS)}`,
    `PROV_COLS = ${JSON.stringify(PROV_COLS)}`,
    'def ensure_cols(df, cols):',
    '    for c in cols:',
    '        if c not in df.columns: df[c] = None',
    '    return df[cols]',
    'def load_all(pattern, cols):',
    '    files = sorted(glob.glob(pattern))',
    '    if not files: return pd.DataFrame(columns=cols)',
    '    return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)',
    `perfect_df = load_all(r"${sessionDir}/batch_*_perfect.parquet", MATCH_COLS)`,
    `tolerance_df = load_all(r"${sessionDir}/batch_*_tolerance.parquet", MATCH_COLS)`,
    `unmatched_c = load_all(r"${sessionDir}/batch_*_unmatched_c.parquet", UNMATCHED_C_COLS)`,
    `unmatched_u = load_all(r"${sessionDir}/batch_*_unmatched_u.parquet", UNMATCHED_U_COLS)`,
    `name_df = load_all(r"${sessionDir}/batch_*_name.parquet", NAME_COLS)`,
    `line_items = load_all(r"${sessionDir}/batch_*_lines.parquet", LINE_COLS)`,
    `prov_raw = load_all(r"${sessionDir}/batch_*_prov.parquet", PROV_COLS)`,
    'if not prov_raw.empty:',
    '    prov_summary = prov_raw.groupby(["Provider Name","Match Status"]).agg({"Unique Claims":"sum","Line Items":"sum","Total Billed":"sum","Total Approved":"sum","Total Difference (Billed - Approved)":"sum"}).reset_index()[PROV_COLS]',
    'else: prov_summary = pd.DataFrame(columns=PROV_COLS)',
    `batch_files = sorted(glob.glob(r"${sessionDir}/batch_*_result.json"))`,
    'date_labels = []',
    'for bf in batch_files:',
    '    br = json.load(open(bf))',
    '    date_labels.append(br.get("date_label",""))',
    'unique_labels = list(dict.fromkeys([l for l in date_labels if l and l != "Unknown"]))',
    'date_label = " + ".join(unique_labels) if unique_labels else "Combined"',
    'safe_label = date_label.replace(" ","_").replace("-","_").replace("+","and")',
    'overall = pd.DataFrame({"Metric":["Total Curacel Claims","Perfect Matches","Tolerance Matches","Unmatched Curacel","Unmatched UAPOM","Name Matches","Total Line Items","Total Billed","Total Approved","Total Difference"],"Value":[len(perfect_df)+len(tolerance_df)+len(unmatched_c),len(perfect_df),len(tolerance_df),len(unmatched_c),len(unmatched_u),len(name_df),len(line_items),line_items["Item Billed"].sum() if "Item Billed" in line_items.columns else 0,line_items["Approved Amount"].sum() if "Approved Amount" in line_items.columns else 0,line_items["Difference (Billed - Approved)"].sum() if "Difference (Billed - Approved)" in line_items.columns else 0]})',
    'HEADER_FILL=PatternFill("solid",start_color="1A2B3C",end_color="1A2B3C")',
    'PERFECT_FILL=PatternFill("solid",start_color="C6EFCE",end_color="C6EFCE")',
    'TOLERANCE_FILL=PatternFill("solid",start_color="FFEB9C",end_color="FFEB9C")',
    'NOT_FOUND_FILL=PatternFill("solid",start_color="FFC7CE",end_color="FFC7CE")',
    'NAME_FILL=PatternFill("solid",start_color="DDEBF7",end_color="DDEBF7")',
    'ALT_FILL=PatternFill("solid",start_color="F5F5F5",end_color="F5F5F5")',
    'HEADER_FONT=Font(bold=True,color="FFFFFF",name="Arial",size=10)',
    'BODY_FONT=Font(name="Arial",size=9)',
    'thin=Side(style="thin",color="D0D0D0")',
    'BORDER=Border(left=thin,right=thin,top=thin,bottom=thin)',
    'def style_sheet(ws, df, fill_fn=None, freeze=True):',
    '    for ci,cn in enumerate(df.columns,1):',
    '        c=ws.cell(row=1,column=ci,value=cn)',
    '        c.fill=HEADER_FILL; c.font=HEADER_FONT',
    '        c.alignment=Alignment(horizontal="center",vertical="center",wrap_text=True)',
    '        c.border=BORDER',
    '    for ri,(_,row) in enumerate(df.iterrows(),2):',
    '        fill=ALT_FILL if ri%2==0 else PatternFill("solid",start_color="FFFFFF",end_color="FFFFFF")',
    '        if fill_fn: fill=fill_fn(row,ri)',
    '        for ci,val in enumerate(row,1):',
    '            c=ws.cell(row=ri,column=ci,value=val)',
    '            c.font=BODY_FONT; c.border=BORDER',
    '            c.alignment=Alignment(vertical="center",wrap_text=False)',
    '            if fill: c.fill=fill',
    '    for ci,cn in enumerate(df.columns,1):',
    '        ml=max(len(str(cn)), df.iloc[:,ci-1].astype(str).str.len().max() if len(df)>0 else 0)',
    '        ws.column_dimensions[get_column_letter(ci)].width=min(ml+4,40)',
    '    ws.row_dimensions[1].height=30',
    '    if freeze: ws.freeze_panes="A2"',
    'def tol_fill(row,ri): return TOLERANCE_FILL if str(row.get("Amount Tolerance Flag",""))=="YES" else PERFECT_FILL',
    'def li_fill(row,ri):',
    '    s=str(row.get("Match Status",""))',
    '    if s=="Perfect Match": return PERFECT_FILL',
    '    if s=="Name Match": return NAME_FILL',
    '    return NOT_FOUND_FILL if ri%2==0 else PatternFill("solid",start_color="FFD7D7",end_color="FFD7D7")',
    'wb=Workbook(); wb.remove(wb.active)',
    'ws=wb.create_sheet("Overall Summary"); style_sheet(ws,overall)',
    'ws2=wb.create_sheet("Perfect Matches")',
    'if not perfect_df.empty: style_sheet(ws2,perfect_df,fill_fn=lambda r,i: PERFECT_FILL)',
    'else: ws2.cell(1,1,"No perfect matches")',
    'ws3=wb.create_sheet("Tolerance Matches")',
    'if not tolerance_df.empty: style_sheet(ws3,tolerance_df,fill_fn=tol_fill)',
    'else: ws3.cell(1,1,"No tolerance matches")',
    'ws4=wb.create_sheet("Unmatched - Curacel")',
    'if not unmatched_c.empty: style_sheet(ws4,unmatched_c,fill_fn=lambda r,i: NOT_FOUND_FILL)',
    'else: ws4.cell(1,1,"All matched")',
    'ws5=wb.create_sheet("Unmatched - UAPOM")',
    'if not unmatched_u.empty: style_sheet(ws5,unmatched_u,fill_fn=lambda r,i: NOT_FOUND_FILL)',
    'else: ws5.cell(1,1,"All matched")',
    'ws6=wb.create_sheet("Name-Based Matches")',
    'if not name_df.empty: style_sheet(ws6,name_df,fill_fn=lambda r,i: NAME_FILL)',
    'else: ws6.cell(1,1,"None found")',
    'ws7=wb.create_sheet("Line Item Analysis")',
    'if not line_items.empty: style_sheet(ws7,line_items,fill_fn=li_fill)',
    'ws8=wb.create_sheet("Provider Summary")',
    'if not prov_summary.empty: style_sheet(ws8,prov_summary)',
    `os.makedirs(r"${outDir}", exist_ok=True)`,
    `master_path=os.path.join(r"${outDir}",f"UAPOM_Analysis_Master_{safe_label}.xlsx")`,
    'wb.save(master_path)',
    `provider_dir=os.path.join(r"${outDir}","providers")`,
    'os.makedirs(provider_dir, exist_ok=True)',
    'providers = line_items["Provider Name"].dropna().unique() if not line_items.empty else []',
    'for provider in providers:',
    '    safe=("".join(c for c in str(provider) if c.isalnum() or c in(" ","-","_")).strip())[:50]',
    '    p_wb=Workbook(); p_wb.remove(p_wb.active)',
    '    p_line=line_items[line_items["Provider Name"]==provider].copy()',
    '    p_perfect=perfect_df[perfect_df["Provider Name"]==provider] if not perfect_df.empty else pd.DataFrame(columns=MATCH_COLS)',
    '    p_tol=tolerance_df[tolerance_df["Provider Name"]==provider] if not tolerance_df.empty else pd.DataFrame(columns=MATCH_COLS)',
    '    p_un=unmatched_c[unmatched_c["Provider Name"]==provider] if not unmatched_c.empty else pd.DataFrame(columns=UNMATCHED_C_COLS)',
    '    p_name=name_df[name_df["Provider Name"]==provider] if not name_df.empty else pd.DataFrame(columns=NAME_COLS)',
    '    p_ov=pd.DataFrame({"Metric":["Claims","Perfect","Tolerance","Unmatched","Name","Line Items","Billed","Approved","Difference"],"Value":[p_line["Claim ID"].nunique(),len(p_perfect),len(p_tol),len(p_un),len(p_name),len(p_line),p_line["Item Billed"].sum() if "Item Billed" in p_line.columns else 0,p_line["Approved Amount"].sum() if "Approved Amount" in p_line.columns else 0,p_line["Difference (Billed - Approved)"].sum() if "Difference (Billed - Approved)" in p_line.columns else 0]})',
    '    ws_s=p_wb.create_sheet("Summary"); style_sheet(ws_s,p_ov,freeze=False)',
    '    if not p_perfect.empty or not p_tol.empty:',
    '        ws_m=p_wb.create_sheet("Matches"); style_sheet(ws_m,pd.concat([p_perfect,p_tol],ignore_index=True),fill_fn=tol_fill)',
    '    if not p_un.empty:',
    '        ws_u=p_wb.create_sheet("Unmatched"); style_sheet(ws_u,p_un,fill_fn=lambda r,i: NOT_FOUND_FILL)',
    '    if not p_name.empty:',
    '        ws_n=p_wb.create_sheet("Name Matches"); style_sheet(ws_n,p_name,fill_fn=lambda r,i: NAME_FILL)',
    '    if not p_line.empty:',
    '        ws_l=p_wb.create_sheet("Line Items"); style_sheet(ws_l,p_line,fill_fn=li_fill)',
    `    p_wb.save(f"{provider_dir}/{safe}_{safe_label}.xlsx")`,
    `zip_path=os.path.join(r"${outDir}",f"UAPOM_Analysis_{safe_label}.zip")`,
    'with zipfile.ZipFile(zip_path,"w",zipfile.ZIP_DEFLATED) as zf:',
    '    zf.write(master_path,os.path.basename(master_path))',
    '    for fname in os.listdir(provider_dir):',
    '        if fname.endswith(".xlsx"):',
    `            zf.write(f"{provider_dir}/{fname}",f"providers/{fname}")`,
    'result={"date_label":date_label,"master_name":os.path.basename(master_path),"zip_name":os.path.basename(zip_path),"perfect_matches":len(perfect_df),"tolerance_matches":len(tolerance_df),"unmatched_curacel":len(unmatched_c),"unmatched_uapom":len(unmatched_u),"name_matches":len(name_df),"providers":len(providers)}',
    'print(json.dumps(result))',
  ].join('\n');
}

export async function POST(request) {
  try {
    const formData = await request.formData();
    const token = formData.get('session_token');
    const curacalFile = formData.get('curacel');
    const finalize = formData.get('finalize') === 'true';

    if (!token) return NextResponse.json({ error: 'Session token required' }, { status: 400 });

    const sessionDir = `${BASE}/session_${token}`;
    if (!existsSync(sessionDir)) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    const uapomPath = `${sessionDir}/uapom.xlsx`;
    const meta = JSON.parse(await readFile(`${sessionDir}/meta.json`, 'utf8'));

    if (finalize) {
      const outDir = `${sessionDir}/output`;
      await mkdir(outDir, { recursive: true });
      const scriptPath = `${sessionDir}/finalize.py`;
      await writeFile(scriptPath, makeFinalizeScript(sessionDir, outDir));
      const { stdout } = await execAsync(`pip install fuzzywuzzy python-Levenshtein openpyxl pandas pyarrow -q && python3 ${scriptPath}`, { timeout: 110000 });
      const result = JSON.parse(stdout.trim().split('\n').pop());
      meta.status = 'finalized';
      meta.final = result;
      await writeFile(`${sessionDir}/meta.json`, JSON.stringify(meta));
      return NextResponse.json({ success: true, finalized: true, ...result, token });
    }

    if (!curacalFile) return NextResponse.json({ error: 'Curacel file required' }, { status: 400 });

    const batchNum = meta.batches + 1;
    const curacalPath = `${sessionDir}/curacel_batch_${batchNum}.csv`;
    const scriptPath = `${sessionDir}/batch_${batchNum}.py`;

    await writeFile(curacalPath, Buffer.from(await curacalFile.arrayBuffer()));
    await writeFile(scriptPath, makeBatchScript(curacalPath, uapomPath, sessionDir, batchNum));

    const { stdout } = await execAsync(
      `pip install fuzzywuzzy python-Levenshtein openpyxl pandas pyarrow -q && python3 ${scriptPath}`,
      { timeout: 110000 }
    );

    const result = JSON.parse(stdout.trim().split('\n').pop());
    meta.batches = batchNum;
    await writeFile(`${sessionDir}/meta.json`, JSON.stringify(meta));

    return NextResponse.json({ success: true, batch: batchNum, ...result, token });
  } catch (err) {
    console.error('[uapom-batch]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
