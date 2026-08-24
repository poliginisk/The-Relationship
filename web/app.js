import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

const canvas = document.getElementById('avatarCanvas');
const loading = document.getElementById('avatarLoading');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const micButton = document.getElementById('micButton');
const statusText = document.getElementById('statusText');
const newChat = document.getElementById('newChat');
const resetAvatar = document.getElementById('resetAvatar');
const voiceToggle = document.getElementById('voiceToggle');
const memoryButton = document.getElementById('memoryButton');
const brandSubtitle = document.getElementById('brandSubtitle');
const conversationLabel = document.getElementById('conversationLabel');
const setupOverlay = document.getElementById('setupOverlay');
const setupForm = document.getElementById('setupForm');
const characterNameInput = document.getElementById('characterNameInput');
const setupSubmit = document.getElementById('setupSubmit');
const setupError = document.getElementById('setupError');
const memoryOverlay = document.getElementById('memoryOverlay');
const memoryClose = document.getElementById('memoryClose');
const memoryList = document.getElementById('memoryList');
const memoryFactCount = document.getElementById('memoryFactCount');
const memoryMessageCount = document.getElementById('memoryMessageCount');
const memorySessionCount = document.getElementById('memorySessionCount');
const memoryPath = document.getElementById('memoryPath');
const resetAllData = document.getElementById('resetAllData');
const presetButtons = Array.from(document.querySelectorAll('[data-camera-preset]'));

let vrm = null;
let avatarRoot = null;
let modelHeight = 1.7;
let baseAvatarY = 0;
let baseRotationY = Math.PI;

let characterName = '';
let appConfigured = false;
let speaking = false;
let requestPending = false;
let transcribing = false;
let voiceEnabled = localStorage.getItem('relationship.voiceEnabled') !== 'false';
let availableVoices = [];
let currentAudio = null;
let currentAudioUrl = null;
let audioContext = null;
let analyser = null;
let analyserData = null;
let lipSyncFrame = null;
let lipSyncLevel = 0;
let avatarState = 'idle';

let blinkTimer = 0;
let nextBlink = 2.5 + Math.random() * 2.5;
let mouseX = 0;
let mouseY = 0;

let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let recording = false;

let cameraPreset = localStorage.getItem('relationship.cameraPreset') || 'full';
if (!['full', 'medium', 'face'].includes(cameraPreset)) cameraPreset = 'full';
let currentZoom = 1;
let baseCameraDistance = 3.2;
let baseCameraY = 1.45;
let baseLookAtY = 1.2;
let targetCameraY = baseCameraY;
let targetCameraZ = baseCameraDistance;
let targetLookAtY = baseLookAtY;
let currentLookAtY = baseLookAtY;

const clock = new THREE.Clock();
const mouseTarget = new THREE.Vector3(0, 1.45, 1.8);
const tempVec = new THREE.Vector3();

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
camera.position.set(0, 1.5, 3.2);

const hemi = new THREE.HemisphereLight(0xf4eaff, 0x130d18, 2.2);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 3, 2.5);
scene.add(key);

const fill = new THREE.DirectionalLight(0xb58aff, 1.1);
fill.position.set(-2, 1.5, 1.2);
scene.add(fill);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(1.3, 64),
  new THREE.MeshBasicMaterial({ color: 0x2a1c36, transparent: true, opacity: 0.16 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

function getBone(name) {
  return vrm?.humanoid?.getNormalizedBoneNode(name) || vrm?.humanoid?.getRawBoneNode(name) || null;
}

function easeBone(bone, x = 0, y = 0, z = 0, speed = 0.12) {
  if (!bone) return;
  bone.rotation.x += (x - bone.rotation.x) * speed;
  bone.rotation.y += (y - bone.rotation.y) * speed;
  bone.rotation.z += (z - bone.rotation.z) * speed;
}

function getHeadWorldY() {
  const head = getBone('head');
  if (!head) return modelHeight * 0.72;
  head.getWorldPosition(tempVec);
  return tempVec.y;
}

function getUpperBodyWorldY() {
  const upperChest = getBone('upperChest') || getBone('chest') || getBone('neck');
  if (!upperChest) return modelHeight * 0.60;
  upperChest.getWorldPosition(tempVec);
  return tempVec.y;
}

function updatePresetButtons() {
  presetButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.cameraPreset === cameraPreset);
  });
}

function updateCameraTargets() {
  targetCameraY = baseCameraY;
  targetCameraZ = baseCameraDistance / currentZoom;
  targetLookAtY = baseLookAtY;
}

function applyCameraPreset(preset = 'full', resetZoom = true) {
  if (!avatarRoot) return;

  const box = new THREE.Box3().setFromObject(avatarRoot);
  const size = box.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 1);
  modelHeight = height;

  const aspect = Math.max(canvas.clientWidth / Math.max(canvas.clientHeight, 1), 0.75);
  const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * aspect);

  cameraPreset = preset;

  if (preset === 'face') {
    const headY = getHeadWorldY();
    baseCameraDistance = Math.max(height * 0.22, 0.72);
    baseCameraY = headY - height * 0.02;
    baseLookAtY = headY;
  } else if (preset === 'medium') {
    const upperY = getUpperBodyWorldY();
    const fitHeight = (height * 0.34) / Math.tan(halfVerticalFov);
    const fitWidth = (Math.max(size.x, height * 0.24) * 0.56) / Math.tan(halfHorizontalFov);
    baseCameraDistance = Math.max(fitHeight, fitWidth) * 1.12;
    baseCameraY = upperY - height * 0.03;
    baseLookAtY = upperY;
  } else {
    const fitHeight = (height * 0.60) / Math.tan(halfVerticalFov);
    const fitWidth = (Math.max(size.x, height * 0.34) * 0.62) / Math.tan(halfHorizontalFov);
    baseCameraDistance = Math.max(fitHeight, fitWidth) * 1.22;
    baseCameraY = height * 0.46;
    baseLookAtY = height * 0.44;
  }

  if (resetZoom) currentZoom = 1;
  updateCameraTargets();
  updatePresetButtons();
}

function frameAvatar() {
  if (!avatarRoot) return;

  const box = new THREE.Box3().setFromObject(avatarRoot);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 1);
  modelHeight = height;

  avatarRoot.position.sub(center);
  avatarRoot.position.y = size.y * 0.12;
  baseAvatarY = avatarRoot.position.y;
  avatarRoot.rotation.y = Math.PI;
  baseRotationY = avatarRoot.rotation.y;

  mouseTarget.set(0, height * 0.58, 2);
  applyCameraPreset(cameraPreset || 'full', true);
  currentLookAtY = targetLookAtY;
  camera.position.y = targetCameraY;
  camera.position.z = targetCameraZ;
  camera.lookAt(0, currentLookAtY, 0);
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  '/models/AvatarSample_M.vrm',
  (gltf) => {
    vrm = gltf.userData.vrm;
    avatarRoot = vrm.scene;
    scene.add(avatarRoot);

    frameAvatar();
    resetExpressionState();
    loading.style.display = 'none';

    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
  },
  undefined,
  (error) => {
    loading.textContent = 'Não foi possível carregar o VRM.';
    console.error(error);
  }
);

function updateAvatarPose(t) {
  if (!vrm?.humanoid) return;

  const sway = Math.sin(t * 1.45) * 0.02;
  const breath = Math.sin(t * 2.0) * 0.015;

  const leftUpperArm = getBone('leftUpperArm');
  const rightUpperArm = getBone('rightUpperArm');
  const leftLowerArm = getBone('leftLowerArm');
  const rightLowerArm = getBone('rightLowerArm');
  const leftHand = getBone('leftHand');
  const rightHand = getBone('rightHand');
  const chest = getBone('chest');
  const neck = getBone('neck');
  const head = getBone('head');

  if (avatarState === 'thinking') {
    easeBone(leftUpperArm, 0.02, sway * 0.18, 1.02 + sway * 0.35, 0.12);
    easeBone(rightUpperArm, 0.04, -0.02, -0.85, 0.12);
    easeBone(leftLowerArm, 0.0, 0.0, 0.10, 0.12);
    easeBone(rightLowerArm, 0.04, 0.0, -1.55, 0.12);
    easeBone(leftHand, 0, 0, 0.02, 0.12);
    easeBone(rightHand, 0.08, 0.0, -0.10, 0.12);
    easeBone(chest, breath * 0.25, 0.02, 0.0, 0.10);
    easeBone(neck, 0.0, 0.0, -0.05, 0.10);
    easeBone(head, -0.04, 0.0, -0.04, 0.10);
  } else if (avatarState === 'speaking') {
    const gesture = Math.sin(t * 2.8);
    easeBone(leftUpperArm, 0.03, sway * 0.18, 1.10 + gesture * 0.04, 0.11);
    easeBone(rightUpperArm, 0.03, -0.03, -0.92 - gesture * 0.09, 0.11);
    easeBone(leftLowerArm, 0.0, 0.0, 0.10, 0.11);
    easeBone(rightLowerArm, 0.0, 0.0, -0.38 + gesture * 0.06, 0.11);
    easeBone(leftHand, 0, 0, 0.03, 0.11);
    easeBone(rightHand, 0, 0, -0.08, 0.11);
    easeBone(chest, breath * 0.2, gesture * 0.012, 0.0, 0.10);
    easeBone(neck, 0.0, 0.0, gesture * 0.015, 0.10);
    easeBone(head, Math.sin(t * 1.4) * 0.018, 0.0, gesture * 0.02, 0.10);
  } else {
    easeBone(leftUpperArm, 0.03, sway * 0.22, 1.16 + sway, 0.12);
    easeBone(rightUpperArm, 0.03, -sway * 0.22, -1.16 - sway, 0.12);
    easeBone(leftLowerArm, 0.0, 0.0, 0.10 + sway * 0.15, 0.12);
    easeBone(rightLowerArm, 0.0, 0.0, -0.10 - sway * 0.15, 0.12);
    easeBone(leftHand, 0, 0, 0.03, 0.12);
    easeBone(rightHand, 0, 0, -0.03, 0.12);
    easeBone(chest, breath * 0.2, 0.0, 0.0, 0.10);
    easeBone(neck, 0.0, 0.0, sway * 0.4, 0.10);
    easeBone(head, Math.sin(t * 0.8) * 0.015, 0.0, Math.sin(t * 0.65) * 0.02, 0.10);
  }
}

function loadSystemVoices() {
  if (!('speechSynthesis' in window)) return;
  availableVoices = window.speechSynthesis.getVoices();
}

function getRelationshipVoice() {
  if (!availableVoices.length) loadSystemVoices();

  const ptBR = availableVoices.filter((voice) => (voice.lang || '').toLowerCase().startsWith('pt-br'));
  const pt = availableVoices.filter((voice) => (voice.lang || '').toLowerCase().startsWith('pt'));
  const preferredName = /(francisca|maria|helena|female|feminina|natural)/i;

  return (
    ptBR.find((voice) => preferredName.test(voice.name)) ||
    ptBR[0] ||
    pt.find((voice) => preferredName.test(voice.name)) ||
    pt[0] ||
    availableVoices[0] ||
    null
  );
}

function cleanTextForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stopVoice() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  if (lipSyncFrame) {
    cancelAnimationFrame(lipSyncFrame);
    lipSyncFrame = null;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }

  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }

  analyser = null;
  analyserData = null;
  lipSyncLevel = 0;
  speaking = false;

  if (avatarState === 'speaking') {
    avatarState = 'idle';
  }

  setMouth('aa', 0);
}

function startAudioLipSync(audioElement) {
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext = new AudioContextClass();
    }

    const source = audioContext.createMediaElementSource(audioElement);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    analyserData = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);
    analyser.connect(audioContext.destination);
    audioContext.resume().catch(() => {});

    const updateLevel = () => {
      if (!speaking || !analyser || !analyserData) {
        lipSyncLevel = 0;
        return;
      }

      analyser.getByteFrequencyData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
      const average = sum / analyserData.length;
      const target = THREE.MathUtils.clamp((average - 4) / 42, 0, 1);
      lipSyncLevel += (target - lipSyncLevel) * 0.42;
      lipSyncFrame = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  } catch (error) {
    console.warn('Lip sync por áudio indisponível:', error);
  }
}

function speakWithSystemVoice(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = getRelationshipVoice();

    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang || 'pt-BR';
    } else {
      utterance.lang = 'pt-BR';
    }

    utterance.rate = 0.96;
    utterance.pitch = 1.08;
    utterance.volume = 1.0;

    utterance.onstart = () => {
      speaking = true;
      avatarState = 'speaking';
      setStatus(`${characterName || 'Ela'} está falando…`, true);
    };

    const finish = () => {
      speaking = false;
      avatarState = 'idle';
      lipSyncLevel = 0;
      setMouth('aa', 0);
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

async function speakReply(text) {
  if (!voiceEnabled) return;

  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return;

  stopVoice();

  try {
    setStatus('preparando voz neural…', true);

    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spokenText })
    });

    if (!response.ok) {
      let message = 'Não foi possível gerar a voz neural.';
      try {
        const data = await response.json();
        message = data.error || message;
      } catch (_) {}
      throw new Error(message);
    }

    const blob = await response.blob();
    currentAudioUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(currentAudioUrl);
    currentAudio.preload = 'auto';

    speaking = true;
    avatarState = 'speaking';
    setStatus(`${characterName || 'Ela'} está falando…`, true);

    startAudioLipSync(currentAudio);

    await new Promise((resolve, reject) => {
      currentAudio.onended = resolve;
      currentAudio.onerror = () => reject(new Error('Erro ao reproduzir o áudio.'));
      currentAudio.play().catch(reject);
    });
  } catch (error) {
    console.warn('Voz neural falhou; usando voz do sistema:', error);
    stopVoice();
    setStatus('usando voz alternativa…', true);
    await speakWithSystemVoice(spokenText);
  } finally {
    if (lipSyncFrame) {
      cancelAnimationFrame(lipSyncFrame);
      lipSyncFrame = null;
    }

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }

    analyser = null;
    analyserData = null;
    lipSyncLevel = 0;
    speaking = false;
    avatarState = 'idle';
    setMouth('aa', 0);

    if (!requestPending) setStatus('pronta para conversar');
  }
}

if ('speechSynthesis' in window) {
  loadSystemVoices();
  window.speechSynthesis.onvoiceschanged = loadSystemVoices;
}

function resetExpressionState() {
  if (!vrm?.expressionManager) return;
  const names = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];
  for (const name of names) vrm.expressionManager.setValue(name, 0);
  vrm.expressionManager.setValue('relaxed', 0.18);
}

function setMood(mood, amount = 0.25) {
  if (!vrm?.expressionManager) return;
  for (const name of ['happy', 'angry', 'sad', 'relaxed', 'surprised']) {
    vrm.expressionManager.setValue(name, name === mood ? amount : 0);
  }
}

function setMouth(name, amount) {
  if (!vrm?.expressionManager) return;
  for (const n of ['aa', 'ih', 'ou', 'ee', 'oh']) {
    vrm.expressionManager.setValue(n, n === name ? amount : 0);
  }
}

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.05);
  const t = performance.now() * 0.001;

  if (vrm && avatarRoot) {
    avatarRoot.position.y = baseAvatarY + Math.sin(t * 1.7) * 0.006;
    avatarRoot.rotation.y += (baseRotationY + mouseX * 0.10 - avatarRoot.rotation.y) * 0.045;
    avatarRoot.rotation.z += (-mouseX * 0.018 - avatarRoot.rotation.z) * 0.04;

    mouseTarget.x = mouseX * 0.75;
    mouseTarget.y = (cameraPreset === 'face' ? getHeadWorldY() : modelHeight * 0.58) + mouseY * -0.18;
    if (vrm.lookAt) vrm.lookAt.lookAt(mouseTarget);

    blinkTimer += delta;
    if (blinkTimer >= nextBlink) {
      blinkTimer = 0;
      nextBlink = 2.4 + Math.random() * 3.8;
      blinkOnce();
    }

    updateAvatarPose(t);

    if (speaking) {
      const mouthAmount = THREE.MathUtils.clamp(lipSyncLevel * 0.95, 0.03, 0.92);
      setMouth('aa', mouthAmount);
    } else {
      lipSyncLevel *= 0.7;
      setMouth('aa', 0);
    }

    camera.position.y += (targetCameraY - camera.position.y) * 0.09;
    camera.position.z += (targetCameraZ - camera.position.z) * 0.09;
    currentLookAtY += (targetLookAtY - currentLookAtY) * 0.09;
    camera.lookAt(0, currentLookAtY, 0);

    vrm.update(delta);
  }

  renderer.render(scene, camera);
}

function blinkOnce() {
  if (!vrm?.expressionManager) return;
  const steps = [0, 0.35, 0.85, 1, 0.65, 0.15, 0];
  let i = 0;
  const timer = setInterval(() => {
    const value = steps[i++];
    if (value === undefined) {
      clearInterval(timer);
      return;
    }
    vrm.expressionManager.setValue('blink', value);
  }, 45);
}

let resizeRaf = 0;
function resizeRenderer() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);

  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    if (canvas.width !== Math.round(width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
    }

    const nextAspect = width / height;
    if (Math.abs(camera.aspect - nextAspect) > 0.0001) {
      camera.aspect = nextAspect;
      camera.updateProjectionMatrix();
    }

    if (avatarRoot) applyCameraPreset(cameraPreset, false);
  });
}

function setChatEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled || requestPending || transcribing;
  micButton.disabled = !enabled || requestPending || transcribing;
  newChat.disabled = !enabled;
}

function updateIdentity(name) {
  characterName = String(name || '').trim();
  brandSubtitle.textContent = characterName || 'Sua companheira virtual';
  conversationLabel.textContent = characterName ? `♡ ${characterName}` : '♡ Conversa atual';
  messageInput.placeholder = characterName ? `Converse com ${characterName}…` : 'Converse com sua personagem…';
  document.title = characterName ? `The Relationship — ${characterName}` : 'The Relationship';
}

function clearChat() {
  const name = characterName || 'sua personagem';
  chatMessages.innerHTML = `
    <div class="chat-empty">
      <div>
        <div class="heart">♡</div>
        <strong>Converse com ${escapeHtml(name)}</strong>
        <div style="margin-top:6px">Cada conversa pode virar uma lembrança para o futuro.</div>
      </div>
    </div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function addMessage(text, role, autoScroll = true) {
  const empty = chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `message-row ${role === 'user' ? 'user' : 'ai'}`;

  const box = document.createElement('div');
  box.className = 'message-stack';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'user' ? 'Você' : (characterName || 'Ela');

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  box.append(meta, bubble);
  row.appendChild(box);
  chatMessages.appendChild(row);

  if (autoScroll) {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }
}

function renderHistory(history) {
  chatMessages.innerHTML = '';
  const items = Array.isArray(history) ? history : [];

  if (!items.length) {
    clearChat();
    return;
  }

  for (const item of items) {
    if (!item || !['user', 'assistant'].includes(item.role)) continue;
    addMessage(item.content || '', item.role === 'user' ? 'user' : 'ai', false);
  }

  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function showSetup() {
  appConfigured = false;
  setChatEnabled(false);
  setupOverlay.classList.remove('hidden');
  setupOverlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => characterNameInput.focus());
}

function hideSetup() {
  setupOverlay.classList.add('hidden');
  setupOverlay.setAttribute('aria-hidden', 'true');
}

async function initializeRelationship() {
  setChatEnabled(false);
  setStatus('carregando memória…', true);

  voiceToggle.classList.toggle('active', voiceEnabled);
  voiceToggle.textContent = voiceEnabled ? '🔊 Voz neural' : '🔇 Voz';
  localStorage.setItem('relationship.voiceEnabled', String(voiceEnabled));

  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Não foi possível carregar a memória.');

    if (!state.configured) {
      updateIdentity('');
      clearChat();
      setStatus('escolha o nome da personagem');
      showSetup();
      return;
    }

    updateIdentity(state.character_name);
    renderHistory(state.history);
    appConfigured = true;
    setChatEnabled(true);
    setStatus(`${characterName} está aqui`);
    messageInput.focus();
  } catch (error) {
    console.error(error);
    updateIdentity('');
    clearChat();
    setStatus(`erro ao carregar memória: ${error.message}`);
    showSetup();
  }
}

async function openMemoryPanel() {
  if (!appConfigured) return;

  memoryOverlay.classList.remove('hidden');
  memoryOverlay.setAttribute('aria-hidden', 'false');
  memoryList.innerHTML = '<div class="memory-empty">Carregando memórias…</div>';

  try {
    const response = await fetch('/api/memories', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro ao carregar memórias.');

    memoryFactCount.textContent = String(data.memory_count ?? 0);
    memoryMessageCount.textContent = String(data.message_count ?? 0);
    memorySessionCount.textContent = String(data.session_count ?? 0);
    memoryPath.textContent = data.data_path || '—';
    memoryPath.title = data.data_path || '';

    const memories = Array.isArray(data.memories) ? data.memories : [];
    memoryList.innerHTML = '';

    if (!memories.length) {
      memoryList.innerHTML = '<div class="memory-empty">Ainda não há fatos consolidados. O histórico completo das conversas já está sendo salvo.</div>';
      return;
    }

    for (const item of memories) {
      const card = document.createElement('div');
      card.className = 'memory-item';

      const category = document.createElement('div');
      category.className = 'memory-category';
      category.textContent = item.category || 'geral';

      const fact = document.createElement('div');
      fact.className = 'memory-fact';
      fact.textContent = item.fact || '';

      card.append(category, fact);
      memoryList.appendChild(card);
    }
  } catch (error) {
    console.error(error);
    memoryList.innerHTML = `<div class="memory-empty">${escapeHtml(error.message)}</div>`;
  }
}

function closeMemoryPanel() {
  memoryOverlay.classList.add('hidden');
  memoryOverlay.setAttribute('aria-hidden', 'true');
  if (appConfigured) messageInput.focus();
}

function setStatus(text, waiting = false) {
  statusText.innerHTML = `<span class="dot" style="background:${waiting ? '#f59e0b' : '#6ee7b7'};box-shadow:0 0 12px ${waiting ? 'rgba(245,158,11,.65)' : 'rgba(110,231,183,.7)'}"></span>${text}`;
}

function syncTextareaHeight() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
}

function setRecordingUI(isRecording) {
  recording = isRecording;
  micButton.classList.toggle('recording', isRecording);
  micButton.textContent = isRecording ? '■' : '🎙';
  micButton.title = isRecording ? 'Parar gravação' : 'Falar por voz';
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function startVoiceRecording() {
  if (requestPending || transcribing) return;
  if (speaking) stopVoice();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const mimeType = mediaRecorder?.mimeType || 'audio/webm';
      const audioBlob = new Blob(recordedChunks, { type: mimeType });
      recordedChunks = [];
      await processRecordedAudio(audioBlob, mimeType);
      stopMicrophone();
    };

    mediaRecorder.start();
    setRecordingUI(true);
    setStatus('ouvindo você…', true);
  } catch (error) {
    console.error(error);
    setRecordingUI(false);
    setStatus('não consegui acessar o microfone');
  }
}

function stopMicrophone() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
}

async function stopVoiceRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    setRecordingUI(false);
    stopMicrophone();
    return;
  }

  setStatus('transcrevendo sua fala…', true);
  setRecordingUI(false);
  mediaRecorder.stop();
}

async function processRecordedAudio(audioBlob, mimeType) {
  if (!audioBlob || audioBlob.size === 0) {
    setStatus('nenhum áudio foi capturado');
    return;
  }

  transcribing = true;
  sendButton.disabled = true;
  micButton.disabled = true;

  try {
    const dataUrl = await blobToDataURL(audioBlob);
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: dataUrl,
        mime_type: mimeType || 'audio/webm'
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro ao transcrever áudio.');

    const transcript = String(data.text || '').trim();
    if (!transcript) {
      setStatus('não entendi o que foi dito');
      return;
    }

    messageInput.value = transcript;
    syncTextareaHeight();
    setStatus('mensagem transcrita');

    // A transcrição terminou. Libera o chat ANTES de chamar sendMessage().
    // Antes, requestPending ficava true aqui e sendMessage() recusava o envio,
    // deixando a interface presa em "carregando".
    transcribing = false;
    sendButton.disabled = false;
    micButton.disabled = false;

    await sendMessage();
  } catch (error) {
    console.error(error);
    setStatus(`erro na transcrição: ${error.message}`);
  } finally {
    transcribing = false;

    if (!requestPending) {
      sendButton.disabled = false;
      micButton.disabled = false;
    }
  }
}

async function toggleVoiceRecording() {
  if (recording) {
    await stopVoiceRecording();
  } else {
    await startVoiceRecording();
  }
}

async function sendMessage(event) {
  event?.preventDefault();
  const message = messageInput.value.trim();
  if (!appConfigured || !message || requestPending || transcribing) return;

  if (speaking) stopVoice();
  if (recording) await stopVoiceRecording();

  addMessage(message, 'user');
  messageInput.value = '';
  syncTextareaHeight();

  sendButton.disabled = true;
  micButton.disabled = true;
  requestPending = true;
  avatarState = 'thinking';
  setMood('surprised', 0.12);
  setStatus(`${characterName || 'Ela'} está pensando…`, true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro desconhecido');

    addMessage(data.reply, 'ai');
    avatarState = 'idle';
    setMood('happy', 0.16);

    requestPending = false;
    sendButton.disabled = false;
    micButton.disabled = false;
    messageInput.focus();

    await speakReply(data.reply);
  } catch (error) {
    addMessage(`Erro: ${error.message}`, 'ai');
    avatarState = 'idle';
    setMood('sad', 0.18);
  } finally {
    requestPending = false;

    if (!speaking) {
      avatarState = 'idle';
      setMouth('aa', 0);
      setStatus('pronta para conversar');
    }

    sendButton.disabled = false;
    micButton.disabled = false;
    messageInput.focus();
  }
}

window.addEventListener('resize', () => {
  pinDocumentToViewport();
  resizeRenderer();
});

function pinDocumentToViewport() {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
}

function normalizeWheelDelta(event) {
  if (event.deltaMode === 1) return event.deltaY * 28;
  if (event.deltaMode === 2) return event.deltaY * Math.max(chatMessages.clientHeight, 1);
  return event.deltaY;
}

chatMessages.addEventListener('wheel', (event) => {
  const maxScroll = Math.max(0, chatMessages.scrollHeight - chatMessages.clientHeight);
  if (maxScroll <= 0) return;

  event.preventDefault();
  const next = chatMessages.scrollTop + normalizeWheelDelta(event);
  chatMessages.scrollTop = Math.max(0, Math.min(maxScroll, next));
}, { passive: false });

chatMessages.addEventListener('keydown', (event) => {
  const page = Math.max(chatMessages.clientHeight * 0.82, 120);
  const maxScroll = Math.max(0, chatMessages.scrollHeight - chatMessages.clientHeight);

  if (event.key === 'PageUp') {
    event.preventDefault();
    chatMessages.scrollTop = Math.max(0, chatMessages.scrollTop - page);
  } else if (event.key === 'PageDown') {
    event.preventDefault();
    chatMessages.scrollTop = Math.min(maxScroll, chatMessages.scrollTop + page);
  } else if (event.key === 'Home') {
    event.preventDefault();
    chatMessages.scrollTop = 0;
  } else if (event.key === 'End') {
    event.preventDefault();
    chatMessages.scrollTop = maxScroll;
  }
});

window.addEventListener('scroll', pinDocumentToViewport, { passive: true });
messageInput.addEventListener('focus', () => {
  requestAnimationFrame(pinDocumentToViewport);
});

const canvasResizeObserver = new ResizeObserver(() => resizeRenderer());
canvasResizeObserver.observe(canvas);
canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  mouseY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
});
canvas.addEventListener('pointerleave', () => {
  mouseX = 0;
  mouseY = 0;
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  currentZoom = Math.min(1.8, Math.max(0.7, currentZoom + event.deltaY * -0.001));
  updateCameraTargets();
}, { passive: false });

resetAvatar.addEventListener('click', () => {
  if (avatarRoot) frameAvatar();
  mouseX = 0;
  mouseY = 0;
  avatarState = 'idle';
});

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const preset = button.dataset.cameraPreset || 'full';
    applyCameraPreset(preset, true);
    localStorage.setItem('relationship.cameraPreset', preset);
  });
});

voiceToggle?.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  voiceToggle.classList.toggle('active', voiceEnabled);
  voiceToggle.textContent = voiceEnabled ? '🔊 Voz neural' : '🔇 Voz';
  localStorage.setItem('relationship.voiceEnabled', String(voiceEnabled));

  if (!voiceEnabled) {
    stopVoice();
    setStatus('voz desativada');
  } else {
    loadSystemVoices();
    setStatus('voz neural ativada');
  }

  messageInput.focus();
});

micButton.addEventListener('click', async (event) => {
  event.preventDefault();
  await toggleVoiceRecording();
});

chatForm.addEventListener('submit', sendMessage);
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
messageInput.addEventListener('input', syncTextareaHeight);

newChat.addEventListener('click', async () => {
  if (!appConfigured || requestPending || transcribing) return;

  stopVoice();
  if (recording) await stopVoiceRecording();

  newChat.disabled = true;
  try {
    const response = await fetch('/api/new_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro ao iniciar nova conversa.');

    clearChat();
    resetExpressionState();
    avatarState = 'idle';
    setMood('relaxed', 0.18);
    setStatus(`${characterName} está pronta para uma nova conversa`);
    messageInput.value = '';
    syncTextareaHeight();
    messageInput.focus();
  } catch (error) {
    console.error(error);
    setStatus(`erro: ${error.message}`);
  } finally {
    newChat.disabled = false;
  }
});

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setupError.textContent = '';

  const requestedName = characterNameInput.value.trim();
  if (!requestedName) {
    setupError.textContent = 'Digite um nome para continuar.';
    return;
  }

  setupSubmit.disabled = true;
  setupSubmit.textContent = 'Salvando…';

  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_name: requestedName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível salvar o nome.');

    updateIdentity(data.character_name);
    appConfigured = true;
    hideSetup();
    clearChat();
    setChatEnabled(true);
    setStatus(`${characterName} está aqui`);
    messageInput.focus();
  } catch (error) {
    console.error(error);
    setupError.textContent = error.message;
  } finally {
    setupSubmit.disabled = false;
    setupSubmit.textContent = 'Começar';
  }
});

memoryButton.addEventListener('click', openMemoryPanel);
memoryClose.addEventListener('click', closeMemoryPanel);
memoryOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === memoryOverlay) closeMemoryPanel();
});

resetAllData.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Isso apagará permanentemente o nome da personagem, todo o histórico e todas as memórias locais. Continuar?'
  );
  if (!confirmed) return;

  resetAllData.disabled = true;
  try {
    const response = await fetch('/api/reset_all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível apagar os dados.');

    stopVoice();
    closeMemoryPanel();
    localStorage.removeItem('relationship.voiceEnabled');
    localStorage.removeItem('relationship.cameraPreset');
    updateIdentity('');
    appConfigured = false;
    characterNameInput.value = '';
    clearChat();
    setStatus('dados apagados');
    showSetup();
  } catch (error) {
    console.error(error);
    window.alert(error.message);
  } finally {
    resetAllData.disabled = false;
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !memoryOverlay.classList.contains('hidden')) {
    closeMemoryPanel();
  }
});

resizeRenderer();
updatePresetButtons();
animate();
initializeRelationship();
