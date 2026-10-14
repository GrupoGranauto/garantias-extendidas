import { describe, expect, it } from "vitest";
import { proximoEnvio, puedeReintentar, tocaCorrer, validarConfig, type ConfigPrimerMensaje } from "../lib/primerMensajeLogica.js";

// 2026-10-12 es lunes; 2026-10-18, domingo.
const cfg: ConfigPrimerMensaje = { activa: true, plantillaId: "p1", diasSemana: [1, 2, 3, 4, 5, 6], hora: "10:30", telefonosPrueba: [] };
const a = (fecha: string, hhmm: string) => ({ fecha, minutos: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) });
const listo = { yaCorrioHoy: false, baseActualizadaHoy: true };

describe("cuándo corre el primer mensaje", () => {
  it("corre en un día permitido, desde su hora y con la base del día", () => {
    expect(tocaCorrer(cfg, a("2026-10-12", "10:30"), listo)).toEqual({ toca: true });
    expect(tocaCorrer(cfg, a("2026-10-12", "15:00"), listo)).toEqual({ toca: true });
  });

  it("no corre antes de su hora, en domingo ni dos veces el mismo día", () => {
    expect(tocaCorrer(cfg, a("2026-10-12", "10:29"), listo)).toEqual({ toca: false, espera: "hora" });
    expect(tocaCorrer(cfg, a("2026-10-18", "12:00"), listo)).toEqual({ toca: false, espera: "dia" });
    expect(tocaCorrer(cfg, a("2026-10-12", "12:00"), { ...listo, yaCorrioHoy: true })).toEqual({ toca: false, espera: "ya_corrio" });
  });

  it("espera la base del día hasta las 18:00; después sale con la que haya", () => {
    const sinBase = { yaCorrioHoy: false, baseActualizadaHoy: false };
    expect(tocaCorrer(cfg, a("2026-10-12", "11:00"), sinBase)).toEqual({ toca: false, espera: "base" });
    expect(tocaCorrer(cfg, a("2026-10-12", "18:00"), sinBase)).toEqual({ toca: true });
  });

  it("nunca después de las 20:00 ni apagada", () => {
    expect(tocaCorrer(cfg, a("2026-10-12", "20:00"), listo)).toEqual({ toca: false, espera: "horario" });
    expect(tocaCorrer({ ...cfg, activa: false }, a("2026-10-12", "12:00"), listo)).toEqual({ toca: false, espera: "apagada" });
    expect(tocaCorrer({ ...cfg, plantillaId: null }, a("2026-10-12", "12:00"), listo)).toEqual({ toca: false, espera: "apagada" });
  });

  it("48 horas puede correr toda la semana si se marcan los 7 días", () => {
    expect(tocaCorrer({ ...cfg, diasSemana: [1, 2, 3, 4, 5, 6, 7] }, a("2026-10-18", "12:00"), listo)).toEqual({ toca: true });
  });
});

describe("próximo envío", () => {
  it("hoy si todavía no corre; si ya pasó su hora y espera la base, en cuanto llegue", () => {
    expect(proximoEnvio(cfg, a("2026-10-12", "09:00"), false)).toEqual({ fecha: "2026-10-12", hora: "10:30" });
    expect(proximoEnvio(cfg, a("2026-10-12", "11:15"), false)).toEqual({ fecha: "2026-10-12", hora: "11:15" });
  });

  it("si hoy ya corrió o no es día permitido, el siguiente día permitido (se salta el domingo)", () => {
    expect(proximoEnvio(cfg, a("2026-10-12", "12:00"), true)).toEqual({ fecha: "2026-10-13", hora: "10:30" });
    expect(proximoEnvio(cfg, a("2026-10-17", "12:00"), true)).toEqual({ fecha: "2026-10-19", hora: "10:30" });
    expect(proximoEnvio(cfg, a("2026-10-18", "09:00"), false)).toEqual({ fecha: "2026-10-19", hora: "10:30" });
  });

  it("apagada no tiene próximo envío", () => {
    expect(proximoEnvio({ ...cfg, activa: false }, a("2026-10-12", "09:00"), false)).toBeNull();
  });
});

describe("reintento", () => {
  it("solo si no se entregó por el límite de marketing de Meta, y al día siguiente o después", () => {
    expect(puedeReintentar({ estado: "fallido", errorCodigo: 131049, fecha: "2026-10-12" }, "2026-10-13")).toBe(true);
    expect(puedeReintentar({ estado: "fallido", errorCodigo: 131049, fecha: "2026-10-13" }, "2026-10-13")).toBe(false);
    expect(puedeReintentar({ estado: "fallido", errorCodigo: 131026, fecha: "2026-10-12" }, "2026-10-13")).toBe(false);
    expect(puedeReintentar({ estado: "entregado", errorCodigo: null, fecha: "2026-10-12" }, "2026-10-13")).toBe(false);
  });
});

describe("configuración válida", () => {
  it("hora dentro del horario, al menos un día y plantilla si está encendida", () => {
    expect(validarConfig(cfg)).toBeNull();
    expect(validarConfig({ ...cfg, hora: "07:59" })).toMatch(/entre las 08:00/);
    expect(validarConfig({ ...cfg, hora: "20:00" })).toMatch(/antes de las 20:00/);
    expect(validarConfig({ ...cfg, diasSemana: [] })).toMatch(/al menos un día/);
    expect(validarConfig({ ...cfg, plantillaId: null })).toMatch(/plantilla/);
    expect(validarConfig({ ...cfg, activa: false, plantillaId: null, diasSemana: [] })).toBeNull();
    expect(validarConfig({ ...cfg, telefonosPrueba: ["6623587553"] })).toBeNull();
    expect(validarConfig({ ...cfg, telefonosPrueba: ["662358755"] })).toMatch(/10 dígitos/);
  });
});
