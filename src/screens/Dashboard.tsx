import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Film, LogOut, Sparkles, Zap, Shield, TrendingUp, Bug, Settings, Loader2, AlertCircle, Cpu } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useAdminStore } from '@/store/useAdminStore';
import { useReportStore } from '@/store/useReportStore';
import { useMaintenanceStore } from '@/store/useMaintenanceStore';
import type { VideoFile } from '@/store/useAppStore';
import { BeforeAfterSlider } from '@/components/BeforeAfterSlider';
import { ProControlsPanel, type VideoFilters } from '@/components/ProControlsPanel';
import { DiagnosticPanel } from '@/components/DiagnosticPanel';
import { ExportButton } from '@/components/ExportButton';
// Paneles pesados que solo se abren bajo demanda → chunks separados (carga inicial más rápida)
const AdminLogin = lazy(() =>
  import('@/components/AdminLogin').then((m) => ({ default: m.AdminLogin }))
);
const AdminDashboard = lazy(() =>
  import('@/components/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);
const ReportModal = lazy(() =>
  import('@/components/ReportModal').then((m) => ({ default: m.ReportModal }))
);
import { MobileTabBar, type MobileTab } from '@/components/MobileTabBar';
import { MobileAdminTab } from '@/components/MobileAdminTab';
import { useIsDesktop, detectGpuName } from '@/services/platformService';

export function Dashboard() {
  // Selectores individuales: el Dashboard no se re-renderiza con cada tick de
  // progreso de exportación (antes suscribía al store completo).
  const user = useAppStore((s) => s.user);
  const logout = useAppStore((s) => s.logout);
  const currentVideo = useAppStore((s) => s.currentVideo);
  const setCurrentVideo = useAppStore((s) => s.setCurrentVideo);
  const runDiagnostics = useAppStore((s) => s.runDiagnostics);
  const diagnosticResult = useAppStore((s) => s.diagnosticResult);
  const startExport = useAppStore((s) => s.startExport);
  const exportSettings = useAppStore((s) => s.exportSettings);
  const processingOptions = useAppStore((s) => s.processingOptions);
  const toggleOption = useAppStore((s) => s.toggleOption);
  const isAdminAuthenticated = useAdminStore((s) => s.isAdminAuthenticated);
  const initSession = useAdminStore((s) => s.initSession);
  const pendingAdminPanel = useAdminStore((s) => s.pendingAdminPanel);
  const consumeAdminPanelRequest = useAdminStore((s) => s.consumeAdminPanelRequest);
  const getPendingCount = useReportStore((s) => s.getPendingCount);
  const maintenanceMode = useMaintenanceStore((s) => s.maintenanceMode);

  // Revoca el blob URL anterior al cambiar de vídeo (evita fugas de memoria:
  // cada blob retiene el archivo completo en RAM hasta revokeObjectURL).
  const prevBlobRef = useRef<string | null>(null);
  const revokePrevBlob = useCallback(() => {
    if (prevBlobRef.current) {
      URL.revokeObjectURL(prevBlobRef.current);
      prevBlobRef.current = null;
    }
  }, []);

  // Restaura la sesión admin desde el almacenamiento cifrado (keyring).
  // Le pasamos la cuenta que entra: sólo si coincide con la del token admin
  // se restaura (un usuario normal jamás hereda el Panel Admin).
  useEffect(() => {
    void initSession(user?.email);
  }, [initSession, user?.email]);

  // Limpieza: revoca el blob URL al desmontar o al quitar el vídeo
  useEffect(() => {
    return () => revokePrevBlob();
  }, [revokePrevBlob]);

  const [isDragging, setIsDragging] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [showAdminDashboard, setShowAdminDashboard] = useState(false);

  // Chip "RTX ACTIVE": sólo se muestra si nvidia-smi confirma una GPU RTX real.
  // Sin backend (web/móvil) o sin GPU NVIDIA → null → no se pinta el chip.
  const [gpuName, setGpuName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    detectGpuName()
      .then((n) => {
        if (alive) setGpuName(n);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const hasRtxGpu = !!gpuName && /\bRTX\b/i.test(gpuName);

  // "Entrar como administrador" (selección de login) → abre el Panel Admin.
  // Se exige `user`: el Dashboard puede montarse antes de completar el login.
  useEffect(() => {
    if (pendingAdminPanel && isAdminAuthenticated && user?.email) {
      setShowAdminDashboard(true);
      consumeAdminPanelRequest();
    }
  }, [pendingAdminPanel, isAdminAuthenticated, user?.email, consumeAdminPanelRequest]);

  const [showReportModal, setShowReportModal] = useState(false);
  // Escritorio = split-screen (preview + panel derecho) | Móvil = Tab Bar inferior
  const isDesktop = useIsDesktop();
  const [mobileTab, setMobileTab] = useState<MobileTab>('preview');
  // Estados reales de interacción: análisis en curso y error de importación
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Ausente en storage antiguo = protegido activado (misma lectura que el motor)
  const antiShadowbanOn = processingOptions.antiDuplicate ?? true;
  const [filters, setFilters] = useState<VideoFilters>({
    sharpness: 100,
    contrast: 1.15,
    saturation: 1.1,
    brightness: 1.0,
    noiseReduction: 0,
    clarity: 0,
    exposure: 0,
    shadows: 0,
    highlights: 0,
  });

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const videoFile = files.find(f => f.type.startsWith('video/'));

    if (videoFile) {
      setFileError(null);
      revokePrevBlob();
      const previewUrl = URL.createObjectURL(videoFile);
      prevBlobRef.current = previewUrl;
      const video: VideoFile = {
        id: crypto.randomUUID(),
        name: videoFile.name,
        size: videoFile.size,
        type: videoFile.type,
        path: videoFile.name,
        previewUrl,
      };
      setCurrentVideo(video);
      runDiagnostics(video);
    } else if (files.length > 0) {
      // Respuesta clara en vez de ignorar el archivo (nunca un botón mudo)
      setFileError('Ese archivo no es de vídeo. Formatos admitidos: MP4, MOV, AVI.');
    }
  }, [setCurrentVideo, runDiagnostics, revokePrevBlob]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Se limpia el input para poder volver a elegir el MISMO archivo tras un error
    e.target.value = '';
    if (!file) return;
    if (file.type.startsWith('video/')) {
      setFileError(null);
      revokePrevBlob();
      const previewUrl = URL.createObjectURL(file);
      prevBlobRef.current = previewUrl;
      const video: VideoFile = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type,
        path: file.name,
        previewUrl,
      };
      setCurrentVideo(video);
      runDiagnostics(video);
    } else {
      setFileError('Ese archivo no es de vídeo. Formatos admitidos: MP4, MOV, AVI.');
    }
  }, [setCurrentVideo, runDiagnostics, revokePrevBlob]);

  // --- Navegación real de la sidebar: cada botón lleva a su sección viva ---
  const scrollToSection = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** Analíticas: re-análisis REAL del vídeo (sonda de metadatos + score). */
  const handleAnalytics = useCallback(async () => {
    if (isAnalyzing || !currentVideo) return;
    setIsAnalyzing(true);
    try {
      await runDiagnostics(currentVideo);
      scrollToSection('editor');
    } finally {
      setIsAnalyzing(false);
    }
  }, [isAnalyzing, currentVideo, runDiagnostics, scrollToSection]);

  /** Anti-Shadowban: alterna la firma anti-duplicado REAL de la exportación. */
  const handleToggleAntiShadowban = useCallback(() => {
    toggleOption('antiDuplicate');
  }, [toggleOption]);

  return (
    <motion.div
      className="min-h-screen flex"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Sidebar (solo escritorio — en móvil lo sustituye el Tab Bar inferior) */}
      <motion.aside
        className="hidden lg:flex w-64 bg-ixi-bgSecondary/50 backdrop-blur-xl border-r border-white/10 flex-col"
        initial={{ x: -100, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        {/* Logo */}
        <div className="p-6 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center">
              <span className="text-lg font-black text-ixi-bg">ixi</span>
            </div>
            <div>
              <h1 className="text-lg font-bold neon-text">ixi 4k</h1>
              <p className="text-xs text-ixi-textMuted">Studio</p>
            </div>
          </div>
        </div>

        {/* Navigation — cada botón ejecuta su función real (navegación,
            re-análisis o alterna la firma anti-duplicado).
            NOTA: "Mejoras", "Anti-Shadowban" y "Analíticas" permanecen en el
            código con toda su funcionalidad, pero ocultos del menú lateral
            (clase `hidden`) a petición explícita. */}
        <nav className="flex-1 p-4 space-y-2">
          <button
            onClick={() => scrollToSection('editor')}
            title="Ir al editor (vista previa y exportación)"
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-ixi-cyan/10 text-ixi-cyan font-medium transition-all"
          >
            <Film className="w-5 h-5" />
            <span>Editor</span>
          </button>
          <button
            hidden
            onClick={() => scrollToSection('mejoras')}
            disabled={!currentVideo}
            title={currentVideo ? 'Ir a presets y filtros' : 'Importa un vídeo para ver las mejoras'}
            className="hidden w-full flex items-center gap-3 px-4 py-3 rounded-xl text-ixi-textMuted hover:bg-ixi-bgCard hover:text-ixi-text transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <Sparkles className="w-5 h-5" />
            <span>Mejoras</span>
          </button>
          <button
            hidden
            onClick={handleToggleAntiShadowban}
            aria-pressed={antiShadowbanOn}
            title={
              antiShadowbanOn
                ? 'Protección anti-duplicado ACTIVADA — clic para desactivarla'
                : 'Protección anti-duplicado DESACTIVADA — clic para activarla'
            }
            className={`hidden w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              antiShadowbanOn
                ? 'bg-ixi-cyan/10 text-ixi-cyan font-medium'
                : 'text-ixi-textMuted hover:bg-ixi-bgCard hover:text-ixi-text'
            }`}
          >
            <Shield className="w-5 h-5" />
            <span>Anti-Shadowban</span>
          </button>
          <button
            hidden
            onClick={handleAnalytics}
            disabled={!currentVideo || isAnalyzing}
            title={
              currentVideo
                ? 'Reanalizar el vídeo y actualizar el score'
                : 'Importa un vídeo para ver sus analíticas'
            }
            className="hidden w-full flex items-center gap-3 px-4 py-3 rounded-xl text-ixi-textMuted hover:bg-ixi-bgCard hover:text-ixi-text transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            {isAnalyzing ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <TrendingUp className="w-5 h-5" />
            )}
            <span>Analíticas</span>
          </button>
          <button
            onClick={() => setShowReportModal(true)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-ixi-textMuted hover:bg-ixi-danger/10 hover:text-ixi-danger transition-all"
          >
            <Bug className="w-5 h-5" />
            <span>Reportar Problema</span>
          </button>
        </nav>

        {/* User section */}
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center">
              <span className="text-sm font-bold text-ixi-bg">
                {user?.email?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.email}</p>
              <p className="text-xs text-ixi-textMuted">Plan Pro</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-4 py-2 rounded-xl text-ixi-textMuted hover:bg-ixi-danger/10 hover:text-ixi-danger transition-all"
          >
            <LogOut className="w-4 h-4" />
            <span>Cerrar sesión</span>
          </button>
        </div>
      </motion.aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="min-h-16 lg:h-16 border-b border-white/10 flex items-center justify-between gap-2 sm:gap-4 flex-wrap py-2 lg:py-0 px-3 sm:px-6 bg-ixi-bgSecondary/30 backdrop-blur-xl">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold truncate">ixi 4k Studio</h2>
            <p className="hidden sm:block text-xs text-ixi-textMuted">Optimiza tus edits para TikTok</p>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-ixi-success/10 border border-ixi-success/30">
              <div className="w-2 h-2 rounded-full bg-ixi-success animate-pulse" />
              <span className="text-xs font-medium text-ixi-success">Sistema activo</span>
            </div>

            {/* Banner de Modo Mantenimiento (solo visible para el admin) */}
            {maintenanceMode && (
              <motion.div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-ixi-warning/15 border border-ixi-warning/50"
                animate={{ opacity: [1, 0.6, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
                title="Los usuarios normales están bloqueados — mantienes acceso completo"
              >
                <Settings className="w-3.5 h-3.5 text-ixi-warning" />
                <span className="text-xs font-bold text-ixi-warning hidden sm:inline">
                  Mantenimiento ACTIVO — usuarios bloqueados
                </span>
                <span className="text-xs font-bold text-ixi-warning sm:hidden">
                  Mantenimiento
                </span>
              </motion.div>
            )}

            {/* Admin Panel toggle (visible when authenticated) */}
            {isAdminAuthenticated && (
              <motion.button
                onClick={() => setShowAdminDashboard(!showAdminDashboard)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  showAdminDashboard
                    ? 'bg-ixi-violet/20 text-ixi-violet border border-ixi-violet/50'
                    : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border hover:border-ixi-violet/50'
                }`}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Film className="w-3.5 h-3.5" />
                {showAdminDashboard ? 'Volver al Editor' : 'Panel Admin'}
              </motion.button>
            )}

            {/* 🛡️ Admin Access Button */}
            <motion.button
              onClick={() => {
                if (isAdminAuthenticated) {
                  setShowAdminDashboard(true);
                } else {
                  setShowAdminLogin(true);
                }
              }}
              className="relative flex items-center gap-2 px-3 py-1.5 rounded-full bg-ixi-bgCard border border-ixi-border hover:border-ixi-violet/60 hover:bg-ixi-violet/10 transition-all group"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              title={isAdminAuthenticated ? 'Panel de Administración' : 'Acceso Administrador'}
            >
              <span className={`text-base leading-none ${isAdminAuthenticated ? 'grayscale-0' : 'grayscale group-hover:grayscale-0'}`}>
                🛡️
              </span>
              <span className="text-xs font-medium text-ixi-textMuted group-hover:text-ixi-violet transition-colors">
                Admin
              </span>
              {/* Pending reports badge */}
              {isAdminAuthenticated && getPendingCount() > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-ixi-danger text-white text-[9px] font-bold flex items-center justify-center border-2 border-ixi-bgSecondary">
                  {getPendingCount()}
                </span>
              )}
              {/* Authenticated indicator */}
              {isAdminAuthenticated && getPendingCount() === 0 && (
                <motion.span
                  className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-ixi-success border-2 border-ixi-bg"
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              )}
            </motion.button>

            {/* Reportar — acceso rápido en móvil */}
            <motion.button
              onClick={() => setShowReportModal(true)}
              className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ixi-bgCard border border-ixi-border hover:border-ixi-danger/50 hover:text-ixi-danger transition-all"
              whileTap={{ scale: 0.95 }}
              title="Reportar problema"
            >
              <Bug className="w-4 h-4 text-ixi-textMuted" />
            </motion.button>
          </div>
        </header>

        {/* Content area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left panel - Video & Controls */}
          <div className="flex-1 flex flex-col p-3 sm:p-6 overflow-y-auto pb-28 lg:pb-6">
            {/* Editor (dropzone / preview) — escritorio: siempre visible;
                móvil: solo en la pestaña "Vista Previa" */}
            <div
              id="editor"
              className={
                isDesktop || mobileTab === 'preview'
                  ? 'flex-1 flex flex-col min-h-0'
                  : 'hidden'
              }
            >
            <AnimatePresence mode="wait">
              {!currentVideo ? (
                <motion.div
                  key="dropzone"
                  className="flex-1 flex items-center justify-center"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <div
                    className={`w-full max-w-2xl aspect-video rounded-3xl border-2 border-dashed transition-all duration-300 flex flex-col items-center justify-center gap-6 cursor-pointer ${
                      isDragging
                        ? 'border-ixi-cyan bg-ixi-cyan/10 scale-[1.02]'
                        : 'border-ixi-border hover:border-ixi-cyan/50 hover:bg-ixi-bgCard/50'
                    }`}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => document.getElementById('file-input')?.click()}
                  >
                    <input
                      id="file-input"
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={handleFileSelect}
                    />
                    <motion.div
                      className={`w-20 h-20 rounded-2xl flex items-center justify-center transition-colors ${
                        isDragging ? 'bg-ixi-cyan/20' : 'bg-ixi-bgCard'
                      }`}
                      animate={isDragging ? { scale: [1, 1.1, 1] } : {}}
                      transition={{ duration: 0.5 }}
                    >
                      <Upload className={`w-10 h-10 ${isDragging ? 'text-ixi-cyan' : 'text-ixi-textMuted'}`} />
                    </motion.div>
                    <div className="text-center">
                      <p className="text-lg font-semibold mb-2">
                        {isDragging ? '¡Suelta tu vídeo aquí!' : 'Arrastra tu vídeo aquí'}
                      </p>
                      <p className="text-sm text-ixi-textMuted">
                        o haz clic para seleccionar • MP4, MOV, AVI
                      </p>
                      {fileError && (
                        <p
                          role="alert"
                          className="mt-3 text-sm text-ixi-danger flex items-center justify-center gap-1.5"
                        >
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          {fileError}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center justify-center gap-3 text-xs">
                      <span className="chip-pro">
                        <Zap className="w-3 h-3" /> 4K UHD
                      </span>
                      <span className="chip-pro">
                        <Film className="w-3 h-3" /> 60 FPS
                      </span>
                      <span className="chip-pro">
                        <Shield className="w-3 h-3" /> Anti-Shadowban
                      </span>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="editor"
                  className="flex-1 flex flex-col gap-6"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                >
                  {/* Video info */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold truncate">{currentVideo.name}</h3>
                      <p className="text-sm text-ixi-textMuted">
                        {(currentVideo.size / 1024 / 1024).toFixed(2)} MB • {currentVideo.type}
                      </p>
                      {/* Chips del perfil de salida (datos reales: GPU detectada
                          vía nvidia-smi + ajustes de exportación vigentes) */}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {hasRtxGpu && (
                          <span className="chip-pro" data-testid="chip-rtx">
                            <Cpu className="w-3 h-3" /> RTX ACTIVE
                          </span>
                        )}
                        {exportSettings.resolution === '4K UHD' && (
                          <span className="chip-pro" data-testid="chip-4k">
                            <Zap className="w-3 h-3" /> 4K UHD
                          </span>
                        )}
                        {exportSettings.resolution === '8K UHD' && (
                          <span className="chip-pro" data-testid="chip-8k">
                            <Zap className="w-3 h-3" /> 8K UHD
                          </span>
                        )}
                        {exportSettings.fps === 60 && (
                          <span className="chip-pro" data-testid="chip-60fps">
                            <Film className="w-3 h-3" /> 60 FPS
                          </span>
                        )}
                        {exportSettings.fps === 120 && (
                          <span className="chip-pro" data-testid="chip-120fps">
                            <Film className="w-3 h-3" /> 120 FPS
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setCurrentVideo(null)}
                      className="btn-ghost text-sm shrink-0"
                    >
                      Cambiar vídeo
                    </button>
                  </div>

                  {/* Before/After Slider with Score */}
                  <div className="relative">
                    <BeforeAfterSlider video={currentVideo} filters={filters} />
                    
                    {/* Score Overlay — sólo lectura: no intercepta el puntero,
                        así el arrastre Before/After sigue funcionando por debajo
                        (en móvil la tarjeta cae sobre el centro del vídeo) */}
                    {diagnosticResult && (
                      <motion.div
                        className="absolute bottom-20 left-4 right-4 z-20 pointer-events-none"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.5 }}
                      >
                        <div className="bg-black/70 backdrop-blur-md rounded-xl p-3 border border-ixi-cyan/30">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-ixi-cyan">Score de Algoritmo y Viralidad</span>
                            <span className={`text-lg font-bold ${
                              diagnosticResult.score >= 80 ? 'text-ixi-success' :
                              diagnosticResult.score >= 50 ? 'text-ixi-warning' : 'text-ixi-danger'
                            }`}>
                              {diagnosticResult.score}%
                            </span>
                          </div>
                          <div className="h-2 bg-ixi-bgSecondary rounded-full overflow-hidden">
                            <motion.div
                              className={`h-full rounded-full ${
                                diagnosticResult.score >= 80 ? 'bg-ixi-success' :
                                diagnosticResult.score >= 50 ? 'bg-ixi-warning' : 'bg-ixi-danger'
                              }`}
                              initial={{ width: 0 }}
                              animate={{ width: `${diagnosticResult.score}%` }}
                              transition={{ duration: 1, ease: 'easeOut' }}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </div>

                  {/* Export */}
                  <ExportButton />
                </motion.div>
              )}
            </AnimatePresence>
            </div>

            {/* ---- Pestañas móviles (Tab Bar inferior) ---- */}
            {!isDesktop && mobileTab === 'quality' && (
              <div className="mt-4">
                <ProControlsPanel
                  section="quality"
                  onFilterChange={setFilters}
                  onExport={startExport}
                />
              </div>
            )}
            {!isDesktop && mobileTab === 'filters' && (
              <div className="mt-4">
                <ProControlsPanel
                  section="filters"
                  onFilterChange={setFilters}
                  onExport={startExport}
                />
              </div>
            )}
            {!isDesktop && mobileTab === 'admin' && (
              <div className="mt-4">
                <MobileAdminTab
                  onOpenAdmin={() =>
                    isAdminAuthenticated ? setShowAdminDashboard(true) : setShowAdminLogin(true)
                  }
                  onOpenReport={() => setShowReportModal(true)}
                />
              </div>
            )}
          </div>

          {/* Right panel - Pro Controls (solo escritorio — split-screen) */}
          {isDesktop && (
            <div id="controls" className="w-80 border-l border-white/10 bg-ixi-bgSecondary/30 backdrop-blur-xl overflow-y-auto">
              {currentVideo ? (
                <ProControlsPanel 
                  onFilterChange={setFilters}
                  onExport={startExport}
                />
              ) : (
                <DiagnosticPanel />
              )}
            </div>
          )}
        </div>
      </main>

      {/* Tab Bar inferior — navegación táctil en móvil */}
      {!isDesktop && (
        <MobileTabBar active={mobileTab} onChange={setMobileTab} pendingReports={getPendingCount()} />
      )}

      {/* Report Modal */}
      <AnimatePresence>
        {showReportModal && (
          <Suspense key="report" fallback={null}>
            <ReportModal onClose={() => setShowReportModal(false)} />
          </Suspense>
        )}
      </AnimatePresence>

      {/* Admin Login Modal */}
      <AnimatePresence>
        {showAdminLogin && (
          <Suspense key="admin-login" fallback={null}>
            <AdminLogin
              onClose={(success) => {
                setShowAdminLogin(false);
                // Login correcto → despliega automáticamente el Admin Panel
                if (success) setShowAdminDashboard(true);
              }}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* Admin Dashboard */}
      <AnimatePresence>
        {showAdminDashboard && isAdminAuthenticated && (
          <Suspense key="admin-dash" fallback={null}>
            <AdminDashboard onClose={() => setShowAdminDashboard(false)} />
          </Suspense>
        )}
      </AnimatePresence>
    </motion.div>
  );
}