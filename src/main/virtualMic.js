'use strict';

const audioDefault = require('./audioDefault');

/**
 * "EvCam Micro": the two ends of the virtual cable are renamed (reversible) and the user's default
 * microphone is never touched. Shared by the app's IPC handlers and the installer's `--setup-mic` mode.
 */
function createVirtualMic(settings) {
  const known = () => ({ captureId: settings.get().audio.virtualMicId, renderId: settings.get().audio.virtualRenderId });
  const status = () => audioDefault.status(known());

  async function create() {
    const st = await status();
    const { capture, render, renamed } = st.virtual;
    if (!st.ok || !capture || !render) return { ok: false, error: 'Le micro virtuel est introuvable : installez le pilote audio gratuit (VB-CABLE), puis recommencez.', status: st };
    if (!renamed || !settings.get().audio.origNames) {
      settings.patch({ audio: {
        virtualMicId: capture.id,
        virtualRenderId: render.id,
        origNames: renamed && settings.get().audio.origNames ? settings.get().audio.origNames
          : JSON.stringify({ capture: { id: capture.id, desc: capture.desc, iface: capture.iface }, render: { id: render.id, desc: render.desc, iface: render.iface } })
      } });
      settings.flush();
    }
    const res = await audioDefault.renameAuto([
      { id: capture.id, ...audioDefault.NAMES.capture },
      { id: render.id, ...audioDefault.NAMES.render }
    ]);
    return { ...res, status: await status() };
  }

  async function revert() {
    let orig = null;
    try { orig = JSON.parse(settings.get().audio.origNames); } catch { /* none saved */ }
    if (!orig) return { ok: false, error: 'Les noms d’origine ne sont pas mémorisés.', status: await status() };
    const res = await audioDefault.renameAuto([orig.capture, orig.render]);
    if (res.ok) settings.patch({ audio: { origNames: '', virtualMicId: '', virtualRenderId: '' } });
    return { ...res, status: await status() };
  }

  return { known, status, create, revert };
}

module.exports = { createVirtualMic };
