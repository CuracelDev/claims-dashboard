'use client';
// app/ops/components/AttendanceGrid.js
import { useAttendanceGrid, getMemberScore } from '../hooks/useAttendanceGrid';

const CELL_META = {
  submitted: { bg: '#00E5A018', color: '#00E5A0', border: '#00E5A033', icon: '✓' },
  leave:     { bg: '#F59E0B18', color: '#F59E0B', border: '#F59E0B33', icon: '🌙' },
  future:    { bg: 'transparent', color: '#3A4A5E', border: '#1E2D45',  icon: '—' },
  missing:   { bg: '#FF4D4D12', color: '#FF4D4D', border: '#FF4D4D33', icon: '○' },
};

export default function AttendanceGrid({ teamMembers, C }) {
  const {
    from, to, setFrom, setTo,
    days, grid, loading, error,
    reload, modal, setModal,
    taskDone, leaveDone,
    acting, createTask, markLeave,
  } = useAttendanceGrid(teamMembers);

  const inp = {
    background: C.elevated, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '7px 12px',
    color: C.text, fontSize: 12, outline: 'none',
  };

  return (
    <div>
      {/* Controls */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: '14px 20px', marginBottom: 16,
        display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
      }}>
        <div>
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>From</div>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>To</div>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </div>
        <button onClick={reload} style={{
          padding: '7px 16px', background: C.accent, color: '#0B0F1A',
          border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer',
        }}>Apply</button>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', alignItems: 'center' }}>
          {[['✓','#00E5A0','Submitted'],['🌙','#F59E0B','On Leave'],['○','#FF4D4D','Missing']].map(([icon,color,label]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12, color }}>{icon}</span>
              <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          marginBottom: 12, background: '#FF4D4D12',
          border: '1px solid #FF4D4D33', color: '#FF4D4D',
          borderRadius: 10, padding: '10px 14px', fontSize: 12,
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Grid */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, overflow: 'auto',
      }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, fontSize: 13 }}>
            Loading attendance...
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.elevated }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', color: C.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', minWidth: 130 }}>
                  Member
                </th>
                {days.map(d => (
                  <th key={d} style={{ padding: '10px 10px', textAlign: 'center', color: C.muted, fontWeight: 600, fontSize: 10, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', minWidth: 64 }}>
                    <div>{new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' })}</div>
                    <div style={{ fontWeight: 400 }}>{new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
                  </th>
                ))}
                <th style={{ padding: '10px 12px', textAlign: 'center', color: C.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}` }}>
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {teamMembers.map((m, mi) => {
                const memberGrid = grid[m.id] || {};
                const score = getMemberScore(memberGrid);
                return (
                  <tr key={m.id} style={{ background: mi % 2 === 0 ? 'transparent' : `${C.elevated}44` }}>
                    <td style={{ padding: '10px 16px', color: C.text, fontWeight: 600, fontSize: 12, borderBottom: `1px solid ${C.border}33`, whiteSpace: 'nowrap' }}>
                      {m.display_name || m.name}
                    </td>
                    {days.map(d => {
                      const status    = memberGrid[d] || 'future';
                      const meta      = CELL_META[status];
                      const actionKey = `${m.id}|${d}`;
                      const isClick   = status === 'missing';
                      const bg    = taskDone[actionKey]  ? '#5B8DEF18' : leaveDone[actionKey] ? '#F59E0B18' : meta.bg;
                      const bdr   = taskDone[actionKey]  ? '#5B8DEF44' : leaveDone[actionKey] ? '#F59E0B44' : meta.border;
                      const color = taskDone[actionKey]  ? '#5B8DEF'   : leaveDone[actionKey] ? '#F59E0B'   : meta.color;
                      const icon  = taskDone[actionKey]  ? '📋'        : leaveDone[actionKey] ? '🌙'        : meta.icon;
                      return (
                        <td key={d} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: `1px solid ${C.border}33` }}>
                          <div
                            onClick={() => isClick && setModal({ member: m, date: d })}
                            title={isClick ? 'Click to take action' : undefined}
                            onMouseEnter={e => { if (isClick) e.currentTarget.style.transform = 'scale(1.15)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                            style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 32, height: 28, borderRadius: 6,
                              background: bg, border: `1px solid ${bdr}`, color,
                              fontSize: 13, cursor: isClick ? 'pointer' : 'default',
                              transition: 'all 0.15s',
                            }}
                          >{icon}</div>
                        </td>
                      );
                    })}
                    <td style={{ padding: '10px 12px', textAlign: 'center', borderBottom: `1px solid ${C.border}33` }}>
                      {score !== null ? (
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: score === 100 ? '#00E5A018' : score >= 60 ? '#F59E0B18' : '#FF4D4D18',
                          color:      score === 100 ? '#00E5A0'   : score >= 60 ? '#F59E0B'   : '#FF4D4D',
                        }}>{score}%</span>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 999,
          background: 'rgba(11,25,41,0.85)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 16, padding: '28px 28px', maxWidth: 400, width: '100%',
            boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>
              Missing Report
            </div>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 20, lineHeight: 1.6 }}>
              <strong style={{ color: C.text }}>{modal.member.display_name || modal.member.name}</strong> did not submit a report for{' '}
              <strong style={{ color: '#F59E0B' }}>
                {new Date(modal.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              </strong>.
              <br />What would you like to do?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              <button
                onClick={createTask}
                disabled={acting || taskDone[`${modal.member.id}|${modal.date}`]}
                style={{
                  padding: '12px 16px', borderRadius: 10, textAlign: 'left',
                  cursor: acting ? 'not-allowed' : 'pointer',
                  background: taskDone[`${modal.member.id}|${modal.date}`] ? '#5B8DEF18' : '#5B8DEF22',
                  border: '1px solid #5B8DEF44', color: '#5B8DEF',
                  fontSize: 13, fontWeight: 600, opacity: acting ? 0.7 : 1,
                }}
              >
                📋 {taskDone[`${modal.member.id}|${modal.date}`] ? 'Task created ✓' : 'Create task — ask them to submit'}
              </button>
              <button
                onClick={markLeave}
                disabled={acting || leaveDone[`${modal.member.id}|${modal.date}`]}
                style={{
                  padding: '12px 16px', borderRadius: 10, textAlign: 'left',
                  cursor: acting ? 'not-allowed' : 'pointer',
                  background: leaveDone[`${modal.member.id}|${modal.date}`] ? '#F59E0B18' : '#F59E0B15',
                  border: '1px solid #F59E0B44', color: '#F59E0B',
                  fontSize: 13, fontWeight: 600, opacity: acting ? 0.7 : 1,
                }}
              >
                🌙 {leaveDone[`${modal.member.id}|${modal.date}`] ? 'Marked as leave ✓' : 'Mark as leave / off day'}
              </button>
            </div>
            <button
              onClick={() => setModal(null)}
              style={{
                width: '100%', padding: '10px', borderRadius: 10,
                background: 'transparent', border: `1px solid ${C.border}`,
                color: C.muted, fontSize: 13, cursor: 'pointer',
              }}
            >Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
