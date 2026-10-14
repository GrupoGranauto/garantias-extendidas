import type { ReactNode } from "react";

/** *negrita*, _cursiva_, ~tachado~, ```monoespaciado``` — el mismo formato que WhatsApp interpreta en el teléfono del cliente. */
export function formatoWhatsApp(texto: string): ReactNode {
  const partes: ReactNode[] = [];
  const regex = /```([^`]+)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
  let ultimo = 0;
  let clave = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(texto))) {
    if (match.index > ultimo) partes.push(texto.slice(ultimo, match.index));
    if (match[1] !== undefined) partes.push(<code key={clave++}>{match[1]}</code>);
    else if (match[2] !== undefined) partes.push(<strong key={clave++}>{match[2]}</strong>);
    else if (match[3] !== undefined) partes.push(<em key={clave++}>{match[3]}</em>);
    else if (match[4] !== undefined) partes.push(<del key={clave++}>{match[4]}</del>);
    ultimo = regex.lastIndex;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}
