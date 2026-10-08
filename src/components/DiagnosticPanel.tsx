import { motion } from 'framer-motion';
import { CheckCircle, AlertTriangle, Shield, Activity } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

export function DiagnosticPanel() {
  const diagnosticResult = useAppStore((s) => s.diagnosticResult);
  const currentVideo = useAppStore((s) => s.currentVideo);

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-ixi-success';
    if (score >= 50) return 'text-ixi-warning';
    return 'text-ixi-danger';
  };

  if (!currentVideo) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-ixi-violet/20 flex items-center justify-center">
            <Activity className="w-5 h-5 text-ixi-violet" />
          </div>
          <div>
            <h3 className="font-semibold">Diagnóstico</h3>
            <p className="text-xs text-ixi-textMuted">Análisis del algoritmo</p>
          </div>
        </div>

        <div className="text-center py-12">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-ixi-bgCard flex items-center justify-center">
            <Shield className="w-8 h-8 text-ixi-textMuted" />
          </div>
          <p className="text-sm text-ixi-textMuted">
            Importa un vídeo para ejecutar el diagnóstico de optimización
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-ixi-violet/20 flex items-center justify-center">
          <Activity className="w-5 h-5 text-ixi-violet" />
        </div>
        <div>
          <h3 className="font-semibold">Diagnóstico</h3>
          <p className="text-xs text-ixi-textMuted">Análisis del algoritmo</p>
        </div>
      </div>

      {diagnosticResult ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          {/* Score */}
          <div className="text-center">
            <div className="relative w-32 h-32 mx-auto mb-4">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-ixi-border"
                />
                <motion.circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="url(#scoreGradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={251.2}
                  initial={{ strokeDashoffset: 251.2 }}
                  animate={{ strokeDashoffset: 251.2 - (251.2 * diagnosticResult.score) / 100 }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                />
                <defs>
                  <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#FF1E42" />
                    <stop offset="100%" stopColor="#E50914" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <div>
                  <span className={`text-3xl font-bold ${getScoreColor(diagnosticResult.score)}`}>
                    {diagnosticResult.score}
                  </span>
                  <span className="text-sm text-ixi-textMuted">%</span>
                </div>
              </div>
            </div>
            <h4 className="font-semibold mb-1">Score de Optimización ixi</h4>
            <p className="text-xs text-ixi-textMuted">
              {diagnosticResult.score >= 80
                ? '¡Excelente! Tu vídeo está listo para máximo alcance'
                : diagnosticResult.score >= 50
                ? 'Buen potencial - Revisa las alertas'
                : 'Necesita atención - Revisa los problemas'}
            </p>
          </div>

          {/* Checks */}
          <div className="space-y-3">
            {Object.entries(diagnosticResult.checks).map(([key, check], index) => (
              <motion.div
                key={key}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + index * 0.1 }}
                className={`p-3 rounded-xl border ${
                  check.passed
                    ? 'bg-ixi-success/5 border-ixi-success/20'
                    : 'bg-ixi-warning/5 border-ixi-warning/20'
                }`}
              >
                <div className="flex items-start gap-3">
                  {check.passed ? (
                    <CheckCircle className="w-5 h-5 text-ixi-success flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-ixi-warning flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className={`text-sm font-medium ${check.passed ? 'text-ixi-success' : 'text-ixi-warning'}`}>
                      {check.passed ? 'Verificado' : 'Atención'}
                    </p>
                    <p className="text-xs text-ixi-textMuted mt-0.5">{check.message}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Anti-duplicate info */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="p-4 rounded-xl bg-gradient-to-br from-ixi-cyan/10 to-ixi-violet/10 border border-ixi-cyan/20"
          >
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-ixi-cyan" />
              <span className="text-sm font-semibold text-ixi-cyan">Anti-Contenido Duplicado</span>
            </div>
            <p className="text-xs text-ixi-textMuted">
              Se aplicará automáticamente un micro-zoom imperceptible (1.5%) y una leve modulación de la firma del archivo para evitar que el algoritmo clasifique el clip como "reutilizado".
            </p>
          </motion.div>
        </motion.div>
      ) : (
        <div className="text-center py-12">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-ixi-bgCard flex items-center justify-center animate-pulse">
            <Activity className="w-8 h-8 text-ixi-textMuted" />
          </div>
          <p className="text-sm text-ixi-textMuted">
            Ejecutando diagnóstico...
          </p>
        </div>
      )}
    </div>
  );
}