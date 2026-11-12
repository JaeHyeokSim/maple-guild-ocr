// 화면 공유 / 이미지 파일 / 붙여넣기 입력.

export const SHARE_FPS = 5;

export async function startShare(video) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: SHARE_FPS }, audio: false });
  // 글자 화면임을 알려 부하가 걸려도 해상도 대신 프레임 수를 줄이게 한다(기본값은 큰 화면을 축소해 숫자가 뭉개짐).
  const track = stream.getVideoTracks()[0];
  if (track && 'contentHint' in track) track.contentHint = 'text';
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopShare(video) {
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

// 붙여넣기·드래그앤드롭으로 들어온 이미지 파일을 콜백으로 넘긴다.
export function bindImageInputs(fileInput, onFiles) {
  const images = list => [...list].filter(f => f.type.startsWith('image/'));
  fileInput.addEventListener('change', () => {
    const files = images(fileInput.files);
    fileInput.value = '';
    if (files.length) onFiles(files);
  });
  document.addEventListener('paste', e => {
    if (e.target.isContentEditable) return;
    const files = images([...e.clipboardData.items].map(i => i.getAsFile()).filter(Boolean));
    if (files.length) { e.preventDefault(); onFiles(files); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = images(e.dataTransfer.files);
    if (files.length) onFiles(files);
  });
}
