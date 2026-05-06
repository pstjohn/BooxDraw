export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 10;
export const ROOM_CODE_VERSION = "booxdraw-room-v1";

export type RoomCodeInfo = {
  code: string;
  date: string;
};

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const formatRoomCode = (code: string) => {
  const normalized = normalizeRoomCode(code);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
};

export const normalizeRoomCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-Z]/g, "");

export const isValidRoomCode = (code: string) => {
  const normalized = normalizeRoomCode(code);
  return (
    normalized.length === ROOM_CODE_LENGTH &&
    [...normalized].every((char) => ROOM_CODE_ALPHABET.includes(char))
  );
};

export const getRoomCodeDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const generateRoomCode = () => {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  window.crypto.getRandomValues(bytes);

  return Array.from(
    bytes,
    (byte) => ROOM_CODE_ALPHABET[byte & 31],
  ).join("");
};

export const deriveCollaborationLinkDataFromRoomCode = async (
  code: string,
  date = getRoomCodeDate(),
) => {
  const normalized = normalizeRoomCode(code);

  if (!isValidRoomCode(normalized)) {
    throw new Error("Invalid room code");
  }

  const input = `${ROOM_CODE_VERSION}:${date}:${normalized}`;
  const digest = new Uint8Array(
    await window.crypto.subtle.digest("SHA-256", textEncoder.encode(input)),
  );

  return {
    roomId: bytesToHex(digest.slice(0, 10)),
    roomKey: bytesToBase64Url(digest.slice(10, 26)),
  };
};
