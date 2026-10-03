import type { Messages } from '../../index.ts';

export const pasteSpecial: Partial<Messages> = {
  'pasteSpecial.title': 'Pegado especial',
  'pasteSpecial.as': 'Como:',
  'pasteSpecial.html': 'Texto con formato (HTML)',
  'pasteSpecial.text': 'Texto sin formato',
  'pasteSpecial.empty': 'No hay nada en el Portapapeles que se pueda pegar.',
  'pasteSpecial.unavailable': 'Este navegador no permite que la página lea el Portapapeles. Pegue con Ctrl+V o Cmd+V.',
  'pasteSpecial.ok': 'Aceptar',
  'pasteSpecial.cancel': 'Cancelar',
};
