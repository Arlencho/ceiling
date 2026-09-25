import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function shareBytes(
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  title: string,
): Promise<void> {
  const file = new File(Paths.cache, name);
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this phone.');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType,
    dialogTitle: title,
  });
}

export async function shareTextFile(name: string, text: string, title: string): Promise<void> {
  const file = new File(Paths.cache, name);
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(text);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this phone.');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/plain',
    dialogTitle: title,
    UTI: 'public.plain-text',
  });
}
