export const DESCRIPTION =
  "I use this tool to record sir's screen or a specific window to a video file, saved under ~/.echo/recordings."

export const PROMPT = `I use this to start and stop a screen recording (video, no audio). Two calls: action="start" begins it (sir may see KDE's native screen-share picker pop up once, to choose the screen or window — for target="window" the picker itself lists his open windows), action="stop" ends it and hands back the saved file path. Only one recording can run at a time.

Use it when sir asks to record his screen, capture a window as video, or make a screen recording/screencast — not for a single still image (use the screenshot tool for that).`
