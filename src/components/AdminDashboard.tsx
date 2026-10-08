import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Users, 
  Film, 
  AlertTriangle, 
  Shield, 
  Ban, 
  CheckCircle, 
  LogOut, 
  Activity,
  Clock,
  X,
  Inbox,
  Trash2,
  MailOpen,
  ShieldAlert,
  Globe,
  Smartphone,
  GitBranch,
  Crown,
  Archive,
  Search,
  Monitor,
  MonitorSmartphone
} from 'lucide-react';
import { useAdminStore, type User } from '@/store/useAdminStore';
import {
  useReportStore,
  getCategoryLabel,
  getCategoryColor,
  getReportPriority,
  getPriorityLabel,
  getPriorityColor,
  REPORT_PRIORITIES,
  type Report,
  type ReportPriority,
} from '@/store/useReportStore';
import { useVersionStore, APP_VERSION } from '@/store/useVersionStore';
import { MaintenanceControl } from '@/components/MaintenanceControl';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ServicesStatusCard } from '@/components/admin/ServicesStatusCard';
import { TwoFactorCard } from '@/components/admin/TwoFactorCard';
import { SessionsCard } from '@/components/admin/SessionsCard';
import { VersionManager } from '@/components/admin/VersionManager';
import { SubscriptionManager } from '@/components/admin/SubscriptionManager';
import { BackupManager } from '@/components/admin/BackupManager';

interface AdminDashboardProps {
  onClose: () => void;
}

type AdminTab =
  | 'overview'
  | 'reports'
  | 'security'
  | 'versions'
  | 'billing'
  | 'backups';

export function AdminDashboard({ onClose }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const { 
    adminEmail, 
    logoutAdmin, 
    metrics, 
    activityStats,
    users, 
    auditLogs, 
    banUser, 
    unbanUser,
    addAuditLog,
    securityEvents 
  } = useAdminStore();
  const { reports, resolveReport, deleteReport, setReportPriority, getPendingCount } = useReportStore();
  const versionCount = useVersionStore((s) => s.versions.length);

  // Gestión avanzada de reportes: búsqueda + filtros de estado/categoría/prioridad
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'resolved'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Report['category']>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | ReportPriority>('all');

  // Confirmaciones para acciones críticas (baneo y borrado de reportes)
  const [pendingBan, setPendingBan] = useState<User | null>(null);
  const [pendingDeleteReport, setPendingDeleteReport] = useState<Report | null>(null);

  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
      if (priorityFilter !== 'all' && getReportPriority(r) !== priorityFilter) return false;
      if (!q) return true;
      return (
        r.message.toLowerCase().includes(q) ||
        r.userId.toLowerCase().includes(q) ||
        r.userEmail.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      );
    });
  }, [reports, search, statusFilter, categoryFilter, priorityFilter]);

  const logAdmin = (action: string, details: string) => {
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail ?? 'admin',
      action,
      details,
      type: 'admin',
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getLogTypeColor = (type: string) => {
    switch (type) {
      case 'export': return 'text-ixi-cyan bg-ixi-cyan/10';
      case 'login': return 'text-ixi-success bg-ixi-success/10';
      case 'error': return 'text-ixi-danger bg-ixi-danger/10';
      case 'security': return 'text-ixi-warning bg-ixi-warning/10';
      case 'admin': return 'text-ixi-violet bg-ixi-violet/10';
      default: return 'text-ixi-textMuted bg-ixi-bgSecondary';
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-ixi-bg overflow-y-auto"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Header */}
      <div className="sticky top-0 z-10 bg-ixi-bg/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-ixi-violet to-ixi-cyan flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-bold neon-text truncate">ixi 4k Admin Panel</h1>
              <p className="text-xs text-ixi-textMuted truncate">Sesión: {adminEmail}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => {
                logoutAdmin();
                onClose();
              }}
              className="btn-ghost text-sm flex items-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Cerrar sesión</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-ixi-bgSecondary text-ixi-textMuted transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6 sm:mb-8">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === 'overview'
                ? 'bg-ixi-cyan/10 text-ixi-cyan border border-ixi-cyan/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-cyan/30'
            }`}
          >
            <Activity className="w-4 h-4" />
            Panel General
          </button>
          <button
            onClick={() => setActiveTab('reports')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all relative ${
              activeTab === 'reports'
                ? 'bg-ixi-violet/10 text-ixi-violet border border-ixi-violet/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-violet/30'
            }`}
          >
            <Inbox className="w-4 h-4" />
            Inbox de Reportes
            {getPendingCount() > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ixi-danger text-white text-[10px] font-bold flex items-center justify-center">
                {getPendingCount()}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all relative ${
              activeTab === 'security'
                ? 'bg-ixi-danger/10 text-ixi-danger border border-ixi-danger/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-danger/30'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            Alertas de Seguridad
            {securityEvents.filter((e) => e.severity === 'critical').length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-ixi-danger text-white text-[10px] font-bold flex items-center justify-center">
                {securityEvents.filter((e) => e.severity === 'critical').length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('versions')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === 'versions'
                ? 'bg-ixi-cyan/10 text-ixi-cyan border border-ixi-cyan/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-cyan/30'
            }`}
          >
            <GitBranch className="w-4 h-4" />
            Versiones
            {versionCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-ixi-bgCard border border-ixi-border text-[10px] font-bold">
                {versionCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('billing')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === 'billing'
                ? 'bg-ixi-warning/10 text-ixi-warning border border-ixi-warning/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-warning/30'
            }`}
          >
            <Crown className="w-4 h-4" />
            Suscripciones
          </button>
          <button
            onClick={() => setActiveTab('backups')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === 'backups'
                ? 'bg-ixi-violet/10 text-ixi-violet border border-ixi-violet/50'
                : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-violet/30'
            }`}
          >
            <Archive className="w-4 h-4" />
            Copias
          </button>
        </div>

        {/* Tab: Overview */}
        {activeTab === 'overview' && (
        <>
        {/* Estado del Sistema — Control Maestro */}
        <MaintenanceControl />

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
          <motion.div
            className="card p-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-ixi-cyan/20 flex items-center justify-center">
                <Users className="w-6 h-6 text-ixi-cyan" />
              </div>
              <span className="text-3xl font-bold text-ixi-cyan">{metrics.totalUsers}</span>
            </div>
            <p className="text-sm text-ixi-textMuted">Usuarios Registrados</p>
            <p className="text-xs text-ixi-success mt-1">{metrics.activeUsers} activos</p>
          </motion.div>

          <motion.div
            className="card p-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-ixi-violet/20 flex items-center justify-center">
                <Film className="w-6 h-6 text-ixi-violet" />
              </div>
              <span className="text-3xl font-bold text-ixi-violet">{metrics.totalVideosProcessed}</span>
            </div>
            <p className="text-sm text-ixi-textMuted">Vídeos Procesados 4K</p>
            <p className="text-xs text-ixi-textMuted mt-1">Total acumulado</p>
          </motion.div>

          <motion.div
            className="card p-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-ixi-danger/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-ixi-danger" />
              </div>
              <span className="text-3xl font-bold text-ixi-danger">{metrics.totalErrors}</span>
            </div>
            <p className="text-sm text-ixi-textMuted">Errores de Renderizado</p>
            <p className="text-xs text-ixi-danger mt-1">Requieren atención</p>
          </motion.div>

          <motion.div
            className="card p-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-ixi-warning/20 flex items-center justify-center">
                <Ban className="w-6 h-6 text-ixi-warning" />
              </div>
              <span className="text-3xl font-bold text-ixi-warning">{metrics.bannedUsers}</span>
            </div>
            <p className="text-sm text-ixi-textMuted">Usuarios Baneados</p>
            <p className="text-xs text-ixi-textMuted mt-1">Cuentas suspendidas</p>
          </motion.div>
        </div>

        {/* Actividad real: accesos por dispositivo y versión */}
        <motion.div
          className="card p-4 sm:p-6 mb-6"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
        >
          <h3 className="font-semibold flex items-center gap-2 mb-4">
            <MonitorSmartphone className="w-5 h-5 text-ixi-cyan" />
            Actividad — accesos reales por dispositivo y versión
          </h3>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: 'PC / Escritorio', icon: <Monitor className="w-4 h-4 text-ixi-cyan" />, value: activityStats.loginsByDevice.pc },
              { label: 'Móvil', icon: <Smartphone className="w-4 h-4 text-ixi-violet" />, value: activityStats.loginsByDevice.movil },
              { label: 'Web', icon: <Globe className="w-4 h-4 text-ixi-warning" />, value: activityStats.loginsByDevice.web },
            ].map((item) => (
              <div
                key={item.label}
                className="p-3 rounded-xl bg-ixi-bgSecondary/50 border border-white/10 text-center"
              >
                <div className="flex justify-center mb-1">{item.icon}</div>
                <p className="text-xl font-bold text-ixi-text">{item.value}</p>
                <p className="text-[11px] text-ixi-textMuted">{item.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-lg bg-ixi-cyan/10 text-ixi-cyan font-mono font-bold">
              v{APP_VERSION}
            </span>
            {Object.keys(activityStats.loginsByVersion).length === 0 ? (
              <span className="text-ixi-textMuted">
                Sin accesos registrados todavía — la versión instalada es {APP_VERSION}
              </span>
            ) : (
              Object.entries(activityStats.loginsByVersion).map(([version, count]) => (
                <span
                  key={version}
                  className={`px-2 py-1 rounded-lg font-mono ${
                    version === APP_VERSION
                      ? 'bg-ixi-cyan/10 text-ixi-cyan'
                      : 'bg-ixi-bgCard text-ixi-textMuted'
                  }`}
                >
                  v{version}: {count} acceso{count === 1 ? '' : 's'}
                </span>
              ))
            )}
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Users Table */}
          <motion.div
            className="card overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <div className="p-4 border-b border-white/10">
              <h3 className="font-semibold flex items-center gap-2">
                <Users className="w-5 h-5 text-ixi-cyan" />
                Usuarios y Seguridad
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">ID</th>
                    <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Email</th>
                    <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Registro</th>
                    <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Estado</th>
                    <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-sm text-ixi-textMuted">
                        Aún no hay usuarios registrados en este dispositivo
                      </td>
                    </tr>
                  ) : users.map((user) => (
                    <tr key={user.id} className="border-b border-white/10 hover:bg-ixi-bgSecondary/30">
                      <td className="p-4 text-xs font-mono text-ixi-textMuted">{user.id}</td>
                      <td className="p-4 text-sm">{user.email}</td>
                      <td className="p-4 text-xs text-ixi-textMuted">{formatDate(user.registeredAt)}</td>
                      <td className="p-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                          user.status === 'active' 
                            ? 'bg-ixi-success/10 text-ixi-success' 
                            : 'bg-ixi-danger/10 text-ixi-danger'
                        }`}>
                          {user.status === 'active' ? (
                            <><CheckCircle className="w-3 h-3" /> Activo</>
                          ) : (
                            <><Ban className="w-3 h-3" /> Baneado</>
                          )}
                        </span>
                      </td>
                      <td className="p-4">
                        {user.status === 'active' ? (
                          <button
                            onClick={() => setPendingBan(user)}
                            className="px-3 py-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger text-xs font-medium hover:bg-ixi-danger/20 transition-colors"
                          >
                            Banear
                          </button>
                        ) : (
                          <button
                            onClick={() => unbanUser(user.id)}
                            className="px-3 py-1.5 rounded-lg bg-ixi-success/10 text-ixi-success text-xs font-medium hover:bg-ixi-success/20 transition-colors"
                          >
                            Reactivar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* Audit Logs */}
          <motion.div
            className="card overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <div className="p-4 border-b border-white/10">
              <h3 className="font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-ixi-violet" />
                Registro de Actividad y Auditoría
              </h3>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {auditLogs.length === 0 ? (
                <div className="p-8 text-center">
                  <Activity className="w-10 h-10 mx-auto mb-2 text-ixi-textMuted opacity-50" />
                  <p className="text-sm text-ixi-textMuted">
                    Sin actividad registrada todavía — los eventos reales aparecerán aquí
                  </p>
                </div>
              ) : auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-4 border-b border-white/10 hover:bg-ixi-bgSecondary/30"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${getLogTypeColor(log.type)}`}>
                        {log.type.toUpperCase()}
                      </span>
                      <span className="text-sm font-medium">{log.action}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-ixi-textMuted">
                      <Clock className="w-3 h-3" />
                      {formatDate(log.timestamp)}
                    </div>
                  </div>
                  <p className="text-xs text-ixi-textMuted mb-1">{log.details}</p>
                  <p className="text-xs text-ixi-textMuted">
                    Usuario: <span className="text-ixi-cyan">{log.userEmail}</span>
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>

        {/* Almacenamiento de datos — descripción veraz de dónde viven los datos */}
        <motion.div
          className="mt-6 p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
        >
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Shield className="w-4 h-4 text-ixi-cyan" />
            Almacenamiento de Datos (local, en este dispositivo)
          </h4>
          <p className="text-xs text-ixi-textMuted mb-3">
            Usuarios, auditoría, reportes y ajustes se guardan en el almacenamiento
            local de la app. Nada se envía a servidores externos.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="p-3 rounded-lg bg-ixi-bgCard">
              <p className="text-ixi-textMuted mb-1">Clave: ixi-4k-admin-storage</p>
              <p className="text-ixi-cyan font-mono">usuarios · auditoría · métricas · alertas</p>
            </div>
            <div className="p-3 rounded-lg bg-ixi-bgCard">
              <p className="text-ixi-textMuted mb-1">Clave: ixi-4k-reports-storage</p>
              <p className="text-ixi-cyan font-mono">reportes de usuarios (inbox)</p>
            </div>
            <div className="p-3 rounded-lg bg-ixi-bgCard">
              <p className="text-ixi-textMuted mb-1">Clave: ixi-4k-storage</p>
              <p className="text-ixi-cyan font-mono">ajustes de edición y preferencias</p>
            </div>
            <div className="p-3 rounded-lg bg-ixi-bgCard">
              <p className="text-ixi-textMuted mb-1">Sesión admin</p>
              <p className="text-ixi-cyan font-mono">keyring del sistema (token cifrado)</p>
            </div>
          </div>
        </motion.div>

        {/* Estado de servicios locales (FFmpeg, backend, red, almacenamiento…) */}
        <ServicesStatusCard />
        </>
        )}

        {/* Tab: Reports Inbox */}
        {activeTab === 'reports' && (
          <motion.div
            className="card overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="p-4 border-b border-white/10 flex items-center justify-between gap-2 flex-wrap">
              <h3 className="font-semibold flex items-center gap-2">
                <Inbox className="w-5 h-5 text-ixi-violet" />
                Inbox de Reportes de Usuarios
              </h3>
              <span className="text-xs text-ixi-textMuted">
                {reports.length} reportes • {getPendingCount()} pendientes
                {filteredReports.length !== reports.length && ` • ${filteredReports.length} visibles`}
              </span>
            </div>

            {/* Búsqueda + filtros de gestión avanzada */}
            <div className="p-3 border-b border-white/10 flex items-center gap-2 flex-wrap bg-ixi-bgSecondary/30">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ixi-textMuted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input-field pl-9 py-2 text-sm"
                  placeholder="Buscar por mensaje, usuario o ID…"
                  aria-label="Buscar reportes"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="input-field py-2 text-sm w-auto"
                aria-label="Filtrar por estado"
              >
                <option value="all">Estado: todos</option>
                <option value="pending">Pendientes</option>
                <option value="resolved">Resueltos</option>
              </select>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
                className="input-field py-2 text-sm w-auto"
                aria-label="Filtrar por categoría"
              >
                <option value="all">Categoría: todas</option>
                <option value="render_error">Fallo de Renderizado 4K</option>
                <option value="audio_sync">Audio desincronizado</option>
                <option value="preview_issue">Problema con la Vista Previa</option>
                <option value="suggestion">Sugerencia / Otro</option>
                <option value="other">Otro</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)}
                className="input-field py-2 text-sm w-auto"
                aria-label="Filtrar por prioridad"
              >
                <option value="all">Prioridad: todas</option>
                <option value="urgent">Urgente</option>
                <option value="high">Alta</option>
                <option value="medium">Media</option>
                <option value="low">Baja</option>
              </select>
              {(search || statusFilter !== 'all' || categoryFilter !== 'all' || priorityFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('all');
                    setCategoryFilter('all');
                    setPriorityFilter('all');
                  }}
                  className="px-3 py-2 rounded-lg bg-ixi-bgCard border border-ixi-border text-xs text-ixi-textMuted hover:text-ixi-cyan transition-colors"
                >
                  Limpiar
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              {reports.length === 0 ? (
                <div className="p-12 text-center">
                  <Inbox className="w-12 h-12 mx-auto mb-3 text-ixi-textMuted opacity-50" />
                  <p className="text-sm text-ixi-textMuted">No hay reportes recibidos</p>
                </div>
              ) : filteredReports.length === 0 ? (
                <div className="p-12 text-center">
                  <Search className="w-12 h-12 mx-auto mb-3 text-ixi-textMuted opacity-50" />
                  <p className="text-sm text-ixi-textMuted">
                    Ningún reporte coincide con la búsqueda o los filtros
                  </p>
                </div>
              ) : (
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">ID Usuario</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Categoría</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Mensaje</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Logs</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Fecha</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Estado</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Prioridad</th>
                      <th className="text-left p-4 text-xs font-medium text-ixi-textMuted">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReports.map((report) => (
                      <tr key={report.id} className="border-b border-white/10 hover:bg-ixi-bgSecondary/30 align-top">
                        <td className="p-4 text-xs font-mono text-ixi-textMuted">{report.userId}</td>
                        <td className="p-4">
                          <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${getCategoryColor(report.category)}`}>
                            {getCategoryLabel(report.category)}
                          </span>
                        </td>
                        <td className="p-4 text-sm max-w-xs">
                          <p className="line-clamp-3">{report.message}</p>
                          {report.hasLogs && report.logs && (
                            <details className="mt-2">
                              <summary className="text-xs text-ixi-cyan cursor-pointer">Ver logs técnicos</summary>
                              <pre className="mt-2 p-2 rounded bg-ixi-bg text-[10px] text-ixi-textMuted whitespace-pre-wrap max-h-32 overflow-y-auto">
                                {report.logs}
                              </pre>
                            </details>
                          )}
                        </td>
                        <td className="p-4">
                          <span className={`text-xs font-medium ${report.hasLogs ? 'text-ixi-success' : 'text-ixi-textMuted'}`}>
                            {report.hasLogs ? 'Adjuntos' : 'Sin logs'}
                          </span>
                        </td>
                        <td className="p-4 text-xs text-ixi-textMuted whitespace-nowrap">
                          {formatDate(report.createdAt)}
                        </td>
                        <td className="p-4">
                          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            report.status === 'pending'
                              ? 'bg-ixi-warning/10 text-ixi-warning'
                              : 'bg-ixi-success/10 text-ixi-success'
                          }`}>
                            {report.status === 'pending' ? 'Pendiente' : 'Resuelto'}
                          </span>
                        </td>
                        <td className="p-4">
                          <span className={`inline-block px-2 py-1 rounded text-xs font-medium mb-1 ${getPriorityColor(getReportPriority(report))}`}>
                            {getPriorityLabel(getReportPriority(report))}
                          </span>
                          <select
                            value={getReportPriority(report)}
                            onChange={(e) => {
                              const next = e.target.value as ReportPriority;
                              setReportPriority(report.id, next);
                              logAdmin(
                                'Prioridad de reporte',
                                `${report.id} → prioridad ${getPriorityLabel(next)}`
                              );
                            }}
                            className="input-field py-1 px-2 text-xs w-full min-w-[90px]"
                            aria-label={`Prioridad del reporte ${report.id}`}
                          >
                            {REPORT_PRIORITIES.map((p) => (
                              <option key={p} value={p}>
                                {getPriorityLabel(p)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            {report.status === 'pending' && (
                              <button
                                onClick={() => {
                                  resolveReport(report.id);
                                  logAdmin(
                                    'Reporte resuelto',
                                    `${report.id} (${getCategoryLabel(report.category)}) marcado como resuelto`
                                  );
                                }}
                                className="p-1.5 rounded-lg bg-ixi-success/10 text-ixi-success hover:bg-ixi-success/20 transition-colors"
                                title="Marcar como Resuelto"
                              >
                                <MailOpen className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={() => setPendingDeleteReport(report)}
                              className="p-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger hover:bg-ixi-danger/20 transition-colors"
                              title="Eliminar reporte"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </motion.div>
        )}

        {/* Tab: Security Alerts */}
        {activeTab === 'security' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* 2FA de la cuenta admin + sesiones/dispositivos activos */}
            <TwoFactorCard />
            <SessionsCard />

            <div className="card p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-ixi-danger" />
                <h3 className="font-semibold">Registro Inmutable de Seguridad</h3>
              </div>
              <span className="text-xs text-ixi-textMuted">
                {securityEvents.length} eventos • IP + Dispositivo + Hora
              </span>
            </div>

            {securityEvents.length === 0 ? (
              <div className="card p-12 text-center">
                <ShieldAlert className="w-12 h-12 mx-auto mb-3 text-ixi-success opacity-70" />
                <p className="text-sm text-ixi-textMuted">
                  Sin actividad sospechosa — todo operativo
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {securityEvents.map((event) => {
                  const severityStyles =
                    event.severity === 'critical'
                      ? { border: 'border-ixi-danger/40', bg: 'bg-ixi-danger/5', badge: 'bg-ixi-danger/15 text-ixi-danger' }
                      : event.severity === 'warning'
                      ? { border: 'border-ixi-warning/40', bg: 'bg-ixi-warning/5', badge: 'bg-ixi-warning/15 text-ixi-warning' }
                      : { border: 'border-ixi-cyan/30', bg: 'bg-ixi-cyan/5', badge: 'bg-ixi-cyan/15 text-ixi-cyan' };

                  return (
                    <div
                      key={event.id}
                      className={`card p-4 border-l-4 ${severityBorder(event.severity)} ${severityStyles.bg}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${severityStyles.badge}`}>
                            {event.severity}
                          </span>
                          <span className="text-sm font-semibold">
                            {securityLabel(event.type)}
                          </span>
                        </div>
                        <span className="text-xs text-ixi-textMuted flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(event.timestamp)}
                        </span>
                      </div>

                      <p className="text-sm text-ixi-textMuted mb-3">{event.details}</p>

                      <div className="flex flex-wrap gap-4 text-xs text-ixi-textMuted">
                        <span className="flex items-center gap-1">
                          <Globe className="w-3.5 h-3.5 text-ixi-cyan" />
                          IP: <span className="font-mono text-ixi-cyan">{event.ip}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Smartphone className="w-3.5 h-3.5 text-ixi-violet" />
                          Dispositivo: <span className="font-mono text-ixi-violet">{event.deviceId}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3.5 h-3.5" />
                          Usuario: <span className="text-ixi-text">{event.userEmail}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}

        {/* Tab: Versiones */}
        {activeTab === 'versions' && <VersionManager />}

        {/* Tab: Suscripciones / premium / cupones */}
        {activeTab === 'billing' && <SubscriptionManager />}

        {/* Tab: Copias de seguridad y recuperación */}
        {activeTab === 'backups' && <BackupManager />}
      </div>

      {/* Confirmación de acciones críticas: baneo de usuario */}
      <ConfirmDialog
        open={!!pendingBan}
        title="Banear usuario"
        message={`Se bloqueará la cuenta de ${pendingBan?.email}: no podrá iniciar sesión hasta que la reactives. La acción queda registrada en la auditoría.`}
        confirmLabel="Banear"
        danger
        onCancel={() => setPendingBan(null)}
        onConfirm={() => {
          if (!pendingBan) return false;
          void banUser(pendingBan.id);
          setPendingBan(null);
          return true;
        }}
      />

      {/* Confirmación de acciones críticas: borrado de reporte */}
      <ConfirmDialog
        open={!!pendingDeleteReport}
        title="Eliminar reporte"
        message={`Se eliminará el reporte ${pendingDeleteReport?.id} de forma permanente (incluidos sus logs adjuntos).`}
        confirmLabel="Eliminar reporte"
        danger
        onCancel={() => setPendingDeleteReport(null)}
        onConfirm={() => {
          if (!pendingDeleteReport) return false;
          logAdmin(
            'Reporte eliminado',
            `${pendingDeleteReport.id} (${getCategoryLabel(pendingDeleteReport.category)}) eliminado del inbox`
          );
          deleteReport(pendingDeleteReport.id);
          setPendingDeleteReport(null);
          return true;
        }}
      />
    </motion.div>
  );
}

function severityBorder(security: string): string {
  if (security === 'critical') return 'border-l-ixi-danger';
  if (security === 'warning') return 'border-l-ixi-warning';
  return 'border-l-ixi-cyan';
}

function securityLabel(type: string): string {
  const labels: Record<string, string> = {
    login_success: 'Acceso Admin concedido',
    login_failed: 'Intento de acceso fallido',
    rate_limited: 'Rate Limit activado (fuerza bruta)',
    role_change: 'Cambio de rol',
    user_banned: 'Usuario baneado',
    user_unbanned: 'Usuario reactivado',
    session_restored: 'Sesión restaurada (keyring)',
    logout: 'Cierre de sesión',
    access_denied: 'Acceso denegado — token inválido',
  };
  return labels[type] || type;
}