"use client";
import { useState, useEffect } from "react";

/* ── colour tokens (matches app/page.js exactly) ─────────── */
const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
};

const PRIORITY_CONFIG = {
  high:   { label: "High",   color: "#FF5C5C", emoji: "🔴" },
  medium: { label: "Medium", color: "#FFB84D", emoji: "🟡" },
  low:    { label: "Low",    color: "#34D399", emoji: "🟢" },
};

const CATEGORY_OPTIONS = [
  "ad_hoc", "claims_processing", "provider_mapping",
  "quality_review", "reporting", "training", "other",
];

const STATUS_COLUMNS = [
  { key: "todo",         label: "To Do",       color: C.sub,     icon: "○" },
  { key: "in_progress",  label: "In Progress", color: "#5B8DEF", icon: "◑" },
  { key: "done",         label: "Done",        color: C.accent,  icon: "●" },
];

/* ── shared style factories (matches app/page.js) ─────────── */
const inp = {
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "8px 12px",
  color: C.text,
  fontSize: 13,
  outline: "none",
  fontFamily: "'DM Sans', sans-serif",
  width: "100%",
  boxSizing: "border-box",
};

const btn = (on, color = C.accent) => ({
  background: on ? color : "transparent",
  color: on ? C.bg : C.sub,
  border: `1px solid ${on ? color : C.border}`,
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all .2s",
});

const abtn = (color = C.accent) => ({
  background: "transparent",
  border: `1px solid ${color}`,
  color,
  borderRadius: 8,
  padding: "10px 20px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  transition: "all .2s",
});

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function isOverdue(due_date, status) {
  if (!due_date || status === "done") return false;
  return new Date(due_date) < new Date(new Date().toDateString());
}

/* ── Stat Card (matches StatCard in app/page.js) ─────────── */
function StatCard({ label, value, icon, color = C.accent, delay = 0 }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: "20px 24px", flex: 1, minWidth: 130, position: "relative",
      overflow: "hidden", animation: `slideUp .5s ease ${delay}s both`,
    }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${color},transparent)` }}/>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, letterSpacing: .5, textTransform: "uppercase", fontWeight: 500 }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: C.text, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -1 }}>
        {value}
      </div>
    </div>
  );
}

/* ── Task Card ───────────────────────────────────────────── */
function TaskCard({ task, onStatusChange, onDelete }) {
  const [moving, setMoving] = useState(false);
  const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
  const overdue = isOverdue(task.due_date, task.status);

  const nextStatus = { todo: "in_progress", in_progress: "done", done: null };
  const prevStatus = { todo: null, in_progress: "todo", done: "in_progress" };

  async function move(newStatus) {
    if (!newStatus || moving) return;
    setMoving(true);
    await onStatusChange(task.id, newStatus, task.team_members?.name);
    setMoving(false);
  }

  return (
    <div style={{
      background: C.elevated,
      border: `1px solid ${overdue ? C.danger + "55" : C.border}`,
      borderLeft: `3px solid ${priority.color}`,
      borderRadius: 10,
      padding: "14px 16px",
      marginBottom: 10,
      opacity: moving ? 0.6 : 1,
      transition: "opacity 0.2s",
      animation: "slideUp .3s ease both",
    }}>
      {/* Title + priority */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text, lineHeight: 1.4, flex: 1 }}>
          {task.title}
        </span>
        <span style={{ fontSize: 11, color: priority.color, whiteSpace: "nowrap", marginTop: 1, fontWeight: 600 }}>
          {priority.emoji} {priority.label}
        </span>
      </div>

      {/* Description */}
      {task.description && (
        <p style={{ fontSize: 12, color: C.sub, marginTop: 6, lineHeight: 1.6, margin: "6px 0 0" }}>
          {task.description}
        </p>
      )}

      {/* Meta chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, fontSize: 11, color: C.muted }}>
        {task.category && (
          <span style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: "2px 10px", fontSize: 10 }}>
            {task.category.replace(/_/g, " ")}
          </span>
        )}
        {task.due_date && (
          <span style={{ color: overdue ? C.danger : C.muted }}>
            📅 {formatDate(task.due_date)}{overdue ? " · OVERDUE" : ""}
          </span>
        )}
        {task.assigned_by && (
          <span style={{ color: C.muted }}>from {task.assigned_by}</span>
        )}
      </div>

      {/* Assigned to / from */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11 }}>
        {task.team_members?.name && (
          <span style={{ color: C.sub }}>→ <strong style={{ color: C.text }}>{task.team_members.name}</strong></span>
        )}
        {task.assigned_by && (
          <span style={{ color: C.muted }}>by {task.assigned_by}</span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {prevStatus[task.status] && (
            <button onClick={() => move(prevStatus[task.status])} disabled={moving}
              style={{ fontSize: 11, padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.border}`,
                background: "transparent", color: C.sub, cursor: "pointer" }}>
              ← Back
            </button>
          )}
          {nextStatus[task.status] && (
            <button onClick={() => move(nextStatus[task.status])} disabled={moving}
              style={{ fontSize: 11, padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.accent}`,
                background: `${C.accent}15`, color: C.accent, cursor: "pointer", fontWeight: 700 }}>
              {task.status === "in_progress" ? "Mark Done ✓" : "Start →"}
            </button>
          )}
          {task.status === "done" && (
            <span style={{ fontSize: 11, color: C.accent, fontWeight: 600 }}>
              ✅ Done {task.completed_at ? formatDate(task.completed_at) : ""}
            </span>
          )}
        </div>
        <button onClick={() => onDelete(task.id)}
          style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.border}`,
            background: "transparent", color: C.muted, cursor: "pointer" }}>
          🗑
        </button>
      </div>
    </div>
  );
}

/* ── Create Task Modal ───────────────────────────────────── */
function CreateTaskModal({ members, onClose, onCreated }) {
  const [form, setForm] = useState({
    title: "", description: "", assigned_to: [], assigned_by: "",
    due_date: "", priority: "medium", category: "ad_hoc",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem("claims_intel_session") || "{}"); if (s.member_name) set("assigned_by", s.member_name); } catch {} }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.title.trim() || form.assigned_to.length === 0) {
      setError("Title and assignee are required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      // Create one task per selected member
      const results = await Promise.all(
        form.assigned_to.map(memberId =>
          fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...form, assigned_to: memberId }),
          }).then(r => r.json())
        )
      );
      results.forEach(data => { if (data.task) onCreated(data.task); });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const label = { fontSize: 12, color: C.sub, marginBottom: 6, display: "block", fontWeight: 500 };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, animation: "fadeIn .2s ease",
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 16,
        padding: 28, width: "100%", maxWidth: 480,
        maxHeight: "90vh", overflowY: "auto", animation: "slideUp .3s ease",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Create New Task</div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>Assignee will be notified via Slack</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.sub, fontSize: 22, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={label}>Task Title *</label>
            <input style={inp} value={form.title} onChange={e => set("title", e.target.value)}
              placeholder="e.g. Review UAP Uganda Q1 claims" />
          </div>
          <div>
            <label style={label}>Description</label>
            <textarea style={{ ...inp, height: 80, resize: "vertical" }} value={form.description}
              onChange={e => set("description", e.target.value)} placeholder="Optional details..." />
          </div>
          <div>
            <label style={label}>Assigned By *</label>
            <div style={{ ...inp, background: C.elevated, color: C.accent, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              🔒 {form.assigned_by || "Unknown"}
            </div>

          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ ...label, margin: 0 }}>Assign To * <span style={{ color: C.muted, fontWeight: 400 }}>({form.assigned_to.length} selected)</span></label>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => set("assigned_to", members.map(m => m.id))}
                  style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1px solid ${C.border}`, background: "transparent", color: C.accent, cursor: "pointer" }}>
                  All
                </button>
                <button type="button" onClick={() => set("assigned_to", [])}
                  style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1px solid ${C.border}`, background: "transparent", color: C.muted, cursor: "pointer" }}>
                  None
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
              {members.map(m => {
                const checked = form.assigned_to.includes(m.id);
                return (
                  <div key={m.id} onClick={() => {
                    const current = form.assigned_to;
                    set("assigned_to", checked ? current.filter(id => id !== m.id) : [...current, m.id]);
                  }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6,
                    background: checked ? `${C.accent}15` : "transparent",
                    border: `1px solid ${checked ? C.accent + "50" : "transparent"}`,
                    cursor: "pointer", transition: "all .15s" }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? C.accent : C.border}`,
                      background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0, transition: "all .15s" }}>
                      {checked && <span style={{ color: C.bg, fontSize: 10, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 12, color: checked ? C.text : C.sub, fontWeight: checked ? 600 : 400 }}>{m.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={label}>Priority</label>
              <select style={inp} value={form.priority} onChange={e => set("priority", e.target.value)}>
                <option value="high">🔴 High</option>
                <option value="medium">🟡 Medium</option>
                <option value="low">🟢 Low</option>
              </select>
            </div>
            <div>
              <label style={label}>Due Date</label>
              <input type="date" style={inp} value={form.due_date} onChange={e => set("due_date", e.target.value)} />
            </div>
          </div>
          <div>
            <label style={label}>Category</label>
            <select style={inp} value={form.category} onChange={e => set("category", e.target.value)}>
              {CATEGORY_OPTIONS.map(c => (
                <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <p style={{ color: C.danger, fontSize: 12, marginTop: 10 }}>{error}</p>}

        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: "11px 0", borderRadius: 8, border: `1px solid ${C.border}`,
              background: "transparent", color: C.sub, fontSize: 13, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
            style={{ flex: 2, padding: "11px 0", borderRadius: 8, border: "none",
              background: saving ? C.muted : C.accent, color: C.bg,
              fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer" }}>
            {saving ? "Creating..." : "Create & Notify →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────── */
export default function TasksPage() {
  const [members, setMembers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedMember, setSelectedMember] = useState("");
  const [viewMode, setViewMode] = useState("my");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("all");

  useEffect(() => { fetchMembers(); fetchTasks(); }, []);

  async function fetchMembers() {
    const res = await fetch("/api/team");
    const data = await res.json();
    const list = data.data || [];
    setMembers(list);
    // Auto-select from session
    try {
      const session = JSON.parse(localStorage.getItem("claims_intel_session") || "{}");
      if (session.member_id) {
        const match = list.find(m => m.id === parseInt(session.member_id));
        if (match) setSelectedMember(String(match.id));
      }
    } catch {}
  }

  async function fetchTasks() {
    setLoading(true);
    const res = await fetch("/api/tasks");
    const data = await res.json();
    setTasks(data.tasks || []);
    setLoading(false);
  }

  async function handleStatusChange(taskId, newStatus, memberName) {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus, completed_by_name: memberName }),
    });
    if (res.ok) {
      const data = await res.json();
      setTasks(prev => prev.map(t => t.id === taskId ? data.task : t));
    }
  }

  async function handleDelete(taskId) {
    if (!confirm("Delete this task? This cannot be undone.")) return;
    const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (res.ok) setTasks(prev => prev.filter(t => t.id !== taskId));
  }

  function handleCreated(newTask) {
    setTasks(prev => [newTask, ...prev]);
  }

  // Filter tasks
  const visibleTasks = tasks.filter(t => {
    const memberMatch = viewMode === "my"
      ? selectedMember && t.assigned_to === parseInt(selectedMember)
      : true;
    const statusMatch = filterStatus === "all" || t.status === filterStatus;
    return memberMatch && statusMatch;
  });

  const tasksByStatus = STATUS_COLUMNS.reduce((acc, col) => {
    acc[col.key] = visibleTasks.filter(t => t.status === col.key);
    return acc;
  }, {});

  // Stats for selected member
  const myTasks = selectedMember ? tasks.filter(t => t.assigned_to === parseInt(selectedMember)) : [];
  const stats = {
    total: myTasks.length,
    todo: myTasks.filter(t => t.status === "todo").length,
    inProgress: myTasks.filter(t => t.status === "in_progress").length,
    done: myTasks.filter(t => t.status === "done").length,
    overdue: myTasks.filter(t => isOverdue(t.due_date, t.status)).length,
  };

  const currentMemberName = members.find(m => m.id === parseInt(selectedMember))?.name || "Admin";

  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 48, height: 48, borderRadius: "50%", border: `3px solid ${C.border}`, borderTopColor: C.accent, animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }}/>
        <div style={{ color: C.sub, fontSize: 14 }}>Loading tasks...</div>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pulse   { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(.7); cursor: pointer }
        ::-webkit-scrollbar { width: 6px; height: 6px }
        ::-webkit-scrollbar-track { background: ${C.bg} }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px }
        select { -webkit-appearance: auto; appearance: auto; cursor: pointer }
      `}</style>

      {/* ── HEADER (matches app/page.js header pattern) ── */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: "14px 28px", display: "flex", alignItems: "center",
        justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.bg }}>C</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -.3 }}>Task Management</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops · {tasks.length} task{tasks.length !== 1 ? "s" : ""} total</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fetchTasks} style={abtn(C.sub)}>🔄 Refresh</button>
          <button onClick={() => setShowCreate(true)} style={{ background: C.accent, color: C.bg, border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + New Task
          </button>
        </div>
      </div>

      {/* ── CONTENT ──────────────────────────────────────── */}
      <div style={{ padding: "20px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* Controls bar */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: "14px 20px", marginBottom: 16,
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
          animation: "slideUp .4s ease both",
        }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>◉ View</div>

          {/* Member selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: C.sub }}>Member</span>
            <select value={selectedMember} onChange={e => setSelectedMember(e.target.value)}
              style={{ ...inp, width: "auto", padding: "7px 12px", fontSize: 12 }}>
              <option value="">Select name...</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>

          <div style={{ height: 24, width: 1, background: C.border }}/>

          {/* My Tasks / All Tasks toggle */}
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { key: "my",  label: "My Tasks" },
              { key: "all", label: "All Tasks" },
            ].map(v => (
              <button key={v.key} onClick={() => setViewMode(v.key)} style={btn(viewMode === v.key)}>
                {v.label}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }}/>

          {/* Status filter */}
          <div style={{ display: "flex", gap: 4 }}>
            {[{ key: "all", label: "All" }, ...STATUS_COLUMNS.map(s => ({ key: s.key, label: s.label }))].map(s => (
              <button key={s.key} onClick={() => setFilterStatus(s.key)}
                style={{ ...btn(filterStatus === s.key), fontSize: 11, padding: "6px 12px" }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Stats bar — only when a member is selected in My Tasks view */}
        {viewMode === "my" && selectedMember && (
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", animation: "slideUp .4s ease .05s both" }}>
            <StatCard label="Total"       value={stats.total}      icon="📋" color={C.accent}   delay={.05} />
            <StatCard label="To Do"       value={stats.todo}       icon="○"  color={C.sub}      delay={.1}  />
            <StatCard label="In Progress" value={stats.inProgress} icon="◑"  color="#5B8DEF"   delay={.15} />
            <StatCard label="Done"        value={stats.done}       icon="●"  color={C.success}  delay={.2}  />
            <StatCard label="Overdue"     value={stats.overdue}    icon="⚠️" color={C.danger}   delay={.25} />
          </div>
        )}

        {/* Empty state — no member selected in My Tasks */}
        {viewMode === "my" && !selectedMember && (
          <div style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: "60px 20px", textAlign: "center", animation: "fadeIn .4s ease",
          }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>👆</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>Select your name</div>
            <div style={{ fontSize: 13, color: C.sub }}>Choose a team member above to see their task board</div>
          </div>
        )}

        {/* Kanban board */}
        {(viewMode === "all" || selectedMember) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, animation: "fadeIn .4s ease" }}>
            {STATUS_COLUMNS.map(col => (
              <div key={col.key}>
                {/* Column header */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  marginBottom: 12, padding: "0 2px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: col.color, fontSize: 16 }}>{col.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{col.label}</span>
                  </div>
                  <span style={{
                    background: C.elevated, border: `1px solid ${C.border}`,
                    borderRadius: 20, padding: "2px 10px", fontSize: 11, color: C.sub,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {tasksByStatus[col.key].length}
                  </span>
                </div>

                {/* Cards */}
                <div style={{ minHeight: 180 }}>
                  {tasksByStatus[col.key].length === 0 ? (
                    <div style={{
                      border: `1px dashed ${C.border}`, borderRadius: 10,
                      padding: "28px 16px", textAlign: "center", color: C.muted, fontSize: 12,
                    }}>
                      No tasks here
                    </div>
                  ) : (
                    tasksByStatus[col.key].map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Task count footer */}
        {(viewMode === "all" || selectedMember) && visibleTasks.length > 0 && (
          <div style={{ marginTop: 16, fontSize: 11, color: C.muted, textAlign: "right" }}>
            Showing {visibleTasks.length} task{visibleTasks.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Create Task Modal */}
      {showCreate && (
        <CreateTaskModal
          members={members}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
