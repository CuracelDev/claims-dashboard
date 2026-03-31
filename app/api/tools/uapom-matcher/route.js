// PATH: app/api/tools/uapom-matcher/route.js
import { writeFile, mkdir, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const execAsync = promisify(exec);

const PYTHON_SCRIPT = `
import pandas as pd
import numpy as np
from openpyxl import Workbook
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from fuzzywuzzy import fuzz
import zipfile, os, sys, json, warnings
warnings.filterwarnings('ignore')

curacel_path = sys.argv[1]
uapom_path = sys.argv[2]
out_dir = sys.argv[3]

uapom = pd.read_excel(uapom_path)
curacel = pd.read_csv(curacel_path, low_memory=False)

uapom['date_only'] = pd.to_datetime(uapom['TRANSACTION']).dt.date
curacel['date_only'] = pd.to_datetime(curacel['Encounter Date']).dt.date

def long_date(d):
    try: return pd.to_datetime(d).strftime('%d %B %Y')
    except: return str(d)

uapom['Date Display'] = uapom['TRANSACTION'].apply(long_date)
curacel['Date Display'] = curacel['Encounter Date'].apply(long_date)

uapom['member_key'] = uapom['MEMBER NUMBER'].astype(str).str.strip().str.upper()
curacel['member_key'] = curacel['Insurance No'].astype(str).str.strip().str.upper()
uapom['AMOUNT'] = pd.to_numeric(uapom['AMOUNT'], errors='coerce').fillna(0)
curacel['Amount Submitted'] = pd.to_numeric(curacel['Amount Submitted'], errors='coerce').fillna(0)
curacel['Item Billed'] = pd.to_numeric(curacel['Item Billed'], errors='coerce').fillna(0)
curacel['Approved Amount'] = pd.to_numeric(curacel['Approved Amount'], errors='coerce').fillna(0)
uapom['name_clean'] = uapom['PATIENT NAME'].astype(str).str.strip().str.upper()
curacel['name_clean'] = curacel['Enrollee Name'].astype(str).str.strip().str.upper()

claim_cols = ['id','member_key','date_only','Date Display','Amount Submitted','Enrollee Name','name_clean','Provider Name','Insurance No','Encounter Date','Amount Approved','Claim Status']
claim_level = curacel.drop_duplicates(subset=['id'])[claim_cols].copy()

TOLERANCE = 2
perfect_rows, tolerance_rows = [], []
uapom_matched_idx, claim_matched_ids = set(), set()

for _, crow in claim_level.iterrows():
    cand = uapom[(uapom['member_key']==crow['member_key'])&(uapom['date_only']==crow['date_only'])]
    if cand.empty: continue
    for uidx, urow in cand.iterrows():
        diff = abs(urow['AMOUNT'] - crow['Amount Submitted'])
        if diff <= TOLERANCE:
            row = {'Claim ID':crow['id'],'Enrollee Name (Curacel)':crow['Enrollee Name'],'Insurance No':crow['Insurance No'],'Encounter Date':crow['Date Display'],'Amount Submitted':crow['Amount Submitted'],'Provider Name':crow['Provider Name'],'Claim Status':crow['Claim Status'],'Patient Name (UAPOM)':urow['PATIENT NAME'],'Member Number (UAPOM)':urow['MEMBER NUMBER'],'Transaction Date (UAPOM)':urow['Date Display'],'Amount (UAPOM)':urow['AMOUNT'],'Provider Name (UAPOM)':urow['PROVIDER NAME'],'Claim Type':urow['CLAIM TYPE'],'Scheme':urow['SCHEME'],'Amount Difference':round(diff,2),'Amount Tolerance Flag':'YES' if diff>0 else 'NO'}
            (tolerance_rows if diff>0 else perfect_rows).append(row)
            uapom_matched_idx.add(uidx)
            claim_matched_ids.add(crow['id'])

perfect_df = pd.DataFrame(perfect_rows)
tolerance_df = pd.DataFrame(tolerance_rows)
all_matched_ids = claim_matched_ids.copy()
unmatched_curacel = claim_level[~claim_level['id'].isin(all_matched_ids)].copy()
unmatched_uapom = uapom[~uapom.index.isin(uapom_matched_idx)].copy()

name_match_rows, fuzzy_matched_claim_ids = [], set()
for _, crow in unmatched_curacel.iterrows():
    best_score, best_urow = 0, None
    cands = unmatched_uapom[(unmatched_uapom['member_key']==crow['member_key'])|(unmatched_uapom['date_only']==crow['date_only'])]
    for _, urow in cands.iterrows():
        score = fuzz.token_sort_ratio(crow['name_clean'], urow['name_clean'])
        if score > best_score: best_score, best_urow = score, urow
    if best_score >= 60 and best_urow is not None:
        name_match_rows.append({'Claim ID':crow['id'],'Enrollee Name (Curacel)':crow['Enrollee Name'],'Insurance No':crow['Insurance No'],'Encounter Date':crow['Date Display'],'Amount Submitted':crow['Amount Submitted'],'Provider Name':crow['Provider Name'],'Patient Name (UAPOM)':best_urow['PATIENT NAME'],'Member Number (UAPOM)':best_urow['MEMBER NUMBER'],'Transaction Date (UAPOM)':best_urow['Date Display'],'Amount (UAPOM)':best_urow['AMOUNT'],'Name Match Score (%)':best_score,'Note':'Name match only — verify manually'})
        fuzzy_matched_claim_ids.add(crow['id'])

name_df = pd.DataFrame(name_match_rows)

line_items = curacel[['id','Provider Name','Enrollee Name','Insurance No','Encounter Date','Date Display','Item Name','Item Billed','Approved Amount','Claim Status','Claim Item Comment']].copy()
line_items['Difference (Billed - Approved)'] = line_items['Item Billed'] - line_items['Approved Amount']
line_items['Match Status'] = line_items['id'].apply(lambda x: 'Perfect Match' if x in all_matched_ids else ('Name Match' if x in fuzzy_matched_claim_ids else 'Not Found'))
line_items = line_items.rename(columns={'id':'Claim ID','Date Display':'Encounter Date (Long)'})

prov_summary = line_items.groupby(['Provider Name','Match Status']).agg(Unique_Claims=('Claim ID','nunique'),Line_Items=('Claim ID','count'),Total_Billed=('Item Billed','sum'),Total_Approved=('Approved Amount','sum'),Total_Difference=('Difference (Billed - Approved)','sum')).reset_index()
prov_summary.columns = ['Provider Name','Match Status','Unique Claims','Line Items','Total Billed','Total Approved','Total Difference (Billed - Approved)']

overall = pd.DataFrame({'Metric':['Total Curacel Claims','Total UAPOM Records','Perfect Matches (Exact)','Matches within Tolerance (≤2)','Total Matched','Unmatched Curacel Claims','Unmatched UAPOM Records','Name-based Possible Matches','Total Curacel Line Items','Total Amount Billed (Curacel)','Total Amount Approved (Curacel)','Total Difference (Billed - Approved)'],'Value':[len(claim_level),len(uapom),len(perfect_df),len(tolerance_df),len(all_matched_ids),len(unmatched_curacel),len(unmatched_uapom),len(name_df),len(line_items),line_items['Item Billed'].sum(),line_items['Approved Amount'].sum(),line_items['Difference (Billed - Approved)'].sum()]})

HEADER_FILL=PatternFill('solid',start_color='1A2B3C',end_color='1A2B3C')
PERFECT_FILL=PatternFill('solid',start_color='C6EFCE',end_color='C6EFCE')
TOLERANCE_FILL=PatternFill('solid',start_color='FFEB9C',end_color='FFEB9C')
NOT_FOUND_FILL=PatternFill('solid',start_color='FFC7CE',end_color='FFC7CE')
NAME_FILL=PatternFill('solid',start_color='DDEBF7',end_color='DDEBF7')
ALT_FILL=PatternFill('solid',start_color='F5F5F5',end_color='F5F5F5')
HEADER_FONT=Font(bold=True,color='FFFFFF',name='Arial',size=10)
BODY_FONT=Font(name='Arial',size=9)
thin=Side(style='thin',color='D0D0D0')
BORDER=Border(left=thin,right=thin,top=thin,bottom=thin)

def style_sheet(ws, df, row_fill_fn=None, freeze=True):
    for ci, cn in enumerate(df.columns,1):
        c=ws.cell(row=1,column=ci,value=cn)
        c.fill=HEADER_FILL; c.font=HEADER_FONT
        c.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
        c.border=BORDER
    for ri,(_, row) in enumerate(df.iterrows(),2):
        fill=ALT_FILL if ri%2==0 else PatternFill('solid',start_color='FFFFFF',end_color='FFFFFF')
        if row_fill_fn: fill=row_fill_fn(row,ri)
        for ci, val in enumerate(row,1):
            c=ws.cell(row=ri,column=ci,value=val)
            c.font=BODY_FONT; c.border=BORDER
            c.alignment=Alignment(vertical='center',wrap_text=False)
            if fill: c.fill=fill
    for ci,cn in enumerate(df.columns,1):
        ml=max(len(str(cn)), df.iloc[:,ci-1].astype(str).str.len().max() if len(df)>0 else 0)
        ws.column_dimensions[get_column_letter(ci)].width=min(ml+4,40)
    ws.row_dimensions[1].height=30
    if freeze: ws.freeze_panes='A2'

def tol_fill(row,ri):
    return TOLERANCE_FILL if row.get('Amount Tolerance Flag','')=='YES' else PERFECT_FILL

def li_fill(row,ri):
    s=row.get('Match Status','')
    if s=='Perfect Match': return PERFECT_FILL
    if s=='Name Match': return NAME_FILL
    return NOT_FOUND_FILL if ri%2==0 else PatternFill('solid',start_color='FFD7D7',end_color='FFD7D7')

wb=Workbook(); wb.remove(wb.active)
ws=wb.create_sheet('Overall Summary'); style_sheet(ws,overall)
for r in range(10,14): ws.cell(r,2).number_format='#,##0.00'

ws2=wb.create_sheet('Perfect Matches')
if not perfect_df.empty: style_sheet(ws2,perfect_df,row_fill_fn=lambda r,i: PERFECT_FILL)
else: ws2.cell(1,1,'No perfect matches found')

ws3=wb.create_sheet('Tolerance Matches (≤2)')
if not tolerance_df.empty: style_sheet(ws3,tolerance_df,row_fill_fn=tol_fill)
else: ws3.cell(1,1,'No tolerance matches found')

ws4=wb.create_sheet('Unmatched - Curacel')
uc=unmatched_curacel[['id','Enrollee Name','Insurance No','Date Display','Amount Submitted','Provider Name','Claim Status']].rename(columns={'id':'Claim ID','Date Display':'Encounter Date'})
if not uc.empty: style_sheet(ws4,uc,row_fill_fn=lambda r,i: NOT_FOUND_FILL)
else: ws4.cell(1,1,'All Curacel claims matched')

ws5=wb.create_sheet('Unmatched - UAPOM')
uu=unmatched_uapom[['CLAIM ID','PATIENT NAME','MEMBER NUMBER','Date Display','AMOUNT','PROVIDER NAME','CLAIM TYPE','SCHEME']].rename(columns={'Date Display':'Transaction Date'})
if not uu.empty: style_sheet(ws5,uu,row_fill_fn=lambda r,i: NOT_FOUND_FILL)
else: ws5.cell(1,1,'All UAPOM records matched')

ws6=wb.create_sheet('Name-Based Matches')
if not name_df.empty: style_sheet(ws6,name_df,row_fill_fn=lambda r,i: NAME_FILL)
else: ws6.cell(1,1,'No name-based matches found')

ws7=wb.create_sheet('Line Item Analysis')
style_sheet(ws7,line_items,row_fill_fn=li_fill)

ws8=wb.create_sheet('Provider Summary')
style_sheet(ws8,prov_summary)
for r in range(2,len(prov_summary)+2):
    for c in [4,5,6]: ws8.cell(row=r,column=c).number_format='#,##0.00'

master_path=os.path.join(out_dir,'UAPOM_Analysis_Master.xlsx')
wb.save(master_path)

provider_dir=os.path.join(out_dir,'providers')
os.makedirs(provider_dir,exist_ok=True)
providers=curacel['Provider Name'].dropna().unique()

for provider in providers:
    safe=("".join(c for c in str(provider) if c.isalnum() or c in(' ','-','_')).strip())[:50]
    p_wb=Workbook(); p_wb.remove(p_wb.active)
    p_line=line_items[line_items['Provider Name']==provider].copy()
    p_perfect=perfect_df[perfect_df['Provider Name']==provider] if not perfect_df.empty else pd.DataFrame()
    p_tol=tolerance_df[tolerance_df['Provider Name']==provider] if not tolerance_df.empty else pd.DataFrame()
    p_un=uc[unmatched_curacel['Provider Name']==provider] if not unmatched_curacel.empty else pd.DataFrame()
    p_name=name_df[name_df['Provider Name']==provider] if not name_df.empty else pd.DataFrame()
    p_ov=pd.DataFrame({'Metric':['Total Claims','Perfect Matches','Tolerance Matches','Unmatched','Name Matches','Total Line Items','Total Billed','Total Approved','Total Difference'],'Value':[p_line['Claim ID'].nunique(),len(p_perfect),len(p_tol),len(p_un),len(p_name),len(p_line),p_line['Item Billed'].sum(),p_line['Approved Amount'].sum(),p_line['Difference (Billed - Approved)'].sum()]})
    ws_s=p_wb.create_sheet('Summary'); style_sheet(ws_s,p_ov,freeze=False)
    ws_s.cell(1,1,f'Provider: {provider}').font=Font(bold=True,name='Arial',size=12)
    for r in [8,9,10]: p_wb['Summary'].cell(r,2).number_format='#,##0.00'
    if not p_perfect.empty or not p_tol.empty:
        ws_m=p_wb.create_sheet('Matches')
        style_sheet(ws_m,pd.concat([p_perfect,p_tol],ignore_index=True),row_fill_fn=tol_fill)
    if not p_un.empty:
        ws_u=p_wb.create_sheet('Unmatched'); style_sheet(ws_u,p_un,row_fill_fn=lambda r,i: NOT_FOUND_FILL)
    if not p_name.empty:
        ws_n=p_wb.create_sheet('Name Matches'); style_sheet(ws_n,p_name,row_fill_fn=lambda r,i: NAME_FILL)
    if not p_line.empty:
        ws_l=p_wb.create_sheet('Line Items'); style_sheet(ws_l,p_line,row_fill_fn=li_fill)
    p_wb.save(f'{provider_dir}/{safe}.xlsx')


# Extract date label from data
try:
    all_dates = pd.to_datetime(curacel['Encounter Date'], errors='coerce').dropna()
    if len(all_dates) > 0:
        min_date = all_dates.min()
        max_date = all_dates.max()
        if min_date.month == max_date.month and min_date.year == max_date.year:
            date_label = min_date.strftime('%b %Y')
        else:
            date_label = f"{min_date.strftime('%b')} - {max_date.strftime('%b %Y')}"
    else:
        date_label = 'Unknown Date'
except:
    date_label = 'Unknown Date'

# Rename output files with date label
safe_label = date_label.replace(' ', '_').replace('-', '_')
final_master = os.path.join(out_dir, f'UAPOM_Analysis_Master_{safe_label}.xlsx')
final_zip = os.path.join(out_dir, f'UAPOM_Analysis_{safe_label}.zip')
os.rename(master_path, final_master)

with zipfile.ZipFile(final_zip,'w',zipfile.ZIP_DEFLATED) as zf:
    zf.write(final_master, f'UAPOM_Analysis_Master_{safe_label}.xlsx')
    for fname in os.listdir(provider_dir):
        if fname.endswith('.xlsx'):
            zf.write(f'{provider_dir}/{fname}', f'providers/{fname}')

result={'perfect_matches':len(perfect_df),'tolerance_matches':len(tolerance_df),'unmatched_curacel':len(unmatched_curacel),'unmatched_uapom':len(unmatched_uapom),'name_matches':len(name_df),'providers':len(providers),'date_label':date_label,'zip_name':f'UAPOM_Analysis_{safe_label}.zip','master_name':f'UAPOM_Analysis_Master_{safe_label}.xlsx'}
print(json.dumps(result))
`;

const TEMP_DIR = '/tmp/uapom-matcher';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const curacalFile = formData.get('curacel');
    const uapomFile = formData.get('uapom');

    if (!curacalFile || !uapomFile) {
      return Response.json({ error: 'Both files required' }, { status: 400 });
    }

    const token = crypto.randomBytes(8).toString('hex');
    const jobDir = `${TEMP_DIR}/${token}`;
    await mkdir(jobDir, { recursive: true });

    const curacalPath = `${jobDir}/curacel.csv`;
    const uapomPath = `${jobDir}/uapom.xlsx`;
    const scriptPath = `${jobDir}/run.py`;

    await writeFile(curacalPath, Buffer.from(await curacalFile.arrayBuffer()));
    await writeFile(uapomPath, Buffer.from(await uapomFile.arrayBuffer()));
    await writeFile(scriptPath, PYTHON_SCRIPT);

    const { stdout, stderr } = await execAsync(
      `pip install fuzzywuzzy python-Levenshtein openpyxl pandas -q && python3 ${scriptPath} ${curacalPath} ${uapomPath} ${jobDir}`,
      { timeout: 110000 }
    );

    const result = JSON.parse(stdout.trim().split('\n').pop());
    result.token = token;

    return Response.json(result);
  } catch (err) {
    console.error('[uapom-matcher]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
