'use client';
import { useRouter } from 'next/navigation';
import { useTheme } from '../context/ThemeContext';

const tools = [
  { id: 'batch-splitter',    name: 'Batch File Splitter',            description: 'Split large CSV or Excel files into operational batches for processing.',                                                                                icon: '⚡', status: 'live',   tags: ['CSV', 'Excel', 'Batch'] },
  { id: 'insurer-feedback',  name: 'Insurer Feedback Intelligence',  description: 'Analyze and categorize insurer feedback patterns automatically.',                                                                                       icon: '🔍', status: 'live',   tags: ['AI', 'Feedback', 'Analysis'] },
  { id: 'report-converter',  name: 'Health Ops Report Converter',    description: 'Convert weekly Health Ops Excel reports into the bulk import CSV format. Upload your file, select your name, download ready-to-import CSV.',           icon: '🔄', status: 'live',   tags: ['Excel', 'CSV', 'Import', 'Reports'] },
  { id: 'uapom-matcher',    name: 'UAPOM Claims Matcher',               description: 'Match and reconcile Curacel extracted claims against UAPOM insurer data. Upload both files, preview column mapping, run analysis and download results.',  icon: '🔀', status: 'live',   tags: ['Matching', 'UAPOM', 'Reconciliation', 'Excel'] },
  { id: 'lookup-matcher',    name: 'Lookup Matcher',                 description: 'Match and reconcile records across datasets quickly.',                                                                                                   icon: '🔗', status: 'coming', tags: ['Matching', 'Reconciliation'] },
  { id: 'sheet-formatter',   name: 'Sheet Formatter',                description: 'Standardize and format operational spreadsheets to template.',                                                                                          icon: '📋', status: 'coming', tags: ['Excel', 'Formatting'] },
];

export default function ToolsPage() {
  const router = useRouter();
  const { C } = useTheme();

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '32px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <span style={{ fontSize: '22px' }}>🛠️</span>
          <h1 style={{ color: C.text, fontSize: '24px', fontWeight: 700, margin: 0 }}>Operational Tools</h1>
        </div>
        <p style={{ color: C.sub, fontSize: '14px', margin: 0 }}>Utilities to support daily claims operations work.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {tools.map((tool) => (
          <div key={tool.id} onClick={() => tool.status === 'live' && router.push(`/tools/${tool.id}`)}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '14px', padding: '24px', cursor: tool.status === 'live' ? 'pointer' : 'default', opacity: tool.status === 'live' ? 1 : 0.55, position: 'relative' }}>
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              {tool.status === 'live'
                ? <span style={{ background: '#00E5A020', color: C.accent, fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '20px' }}>Live</span>
                : <span style={{ background: '#4A556830', color: C.sub, fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '20px' }}>Soon</span>}
            </div>
            <div style={{ fontSize: '28px', marginBottom: '14px' }}>{tool.icon}</div>
            <h3 style={{ color: C.text, fontSize: '16px', fontWeight: 700, margin: '0 0 8px 0' }}>{tool.name}</h3>
            <p style={{ color: C.sub, fontSize: '13px', margin: '0 0 16px 0', lineHeight: '1.5' }}>{tool.description}</p>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {tool.tags.map(tag => <span key={tag} style={{ background: C.elevated, color: C.sub, fontSize: '11px', padding: '3px 8px', borderRadius: '6px' }}>{tag}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
