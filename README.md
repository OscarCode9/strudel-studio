# Strudel Studio · Salgo Pa’ la Calle

Estudio musical visual con Playlist, Channel Rack, Piano Roll, Mixer y editor de Strudel sincronizado. Incluye la versión progresiva actual de **Salgo Pa’ la Calle**, con sus dos pasajes de voz y la mezcla final en MP3.

## Escuchar la mezcla

[Descargar o escuchar el MP3 final](https://github.com/OscarCode9/strudel-studio/releases/latest/download/salgo-progresiva-dos-voces.mp3)

La mezcla dura aproximadamente **2:52**:

- La primera voz entra en 0:04: «Salgo pa’ la calle sin rumbo, como un vagabundo sin rumbo».
- Después de la voz hay una preparación de dos compases con intro, hats, bajo filtrado y redoble. La base completa entra en 0:14.743.
- La segunda toma vocal empieza en 0:35.20. El regreso de la base en 0:44.91 coincide con el marcador del final del conteo, a 9.714 s de la toma.

## Ejecutar el estudio

Requisitos: Node.js 22 y pnpm 10.15.0.

```bash
git clone https://github.com/OscarCode9/strudel-studio.git
cd strudel-studio
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Abre **http://localhost:4321/studio/?v=salgo-progresiva** y pulsa **Play** en modo **SONG**. La reproducción necesita una interacción inicial con el navegador.

Las dos voces de esta versión están incluidas en `website/public/local-audio/`. No hacen falta credenciales ni archivos de la computadora del autor. Algunas muestras y bancos de los otros proyectos del selector utilizan conexiones externas; los patrones históricos que necesitan otras grabaciones privadas no las incluyen.

## Archivos principales

- `my-patterns/calle-progresiva.txt`: canción actual con notas, síntesis, voces y arreglo.
- `my-patterns/calle-progresiva-visual.txt`: versión con gráficos de notas.
- `website/src/daw/`: interfaz y motor del estudio.
- `website/public/local-audio/`: los dos pasajes de voz de la canción actual.
- `website/public/preview-audio/salgo-progresiva-dos-voces.mp3`: exportación completa.

## Verificar y construir

```bash
pnpm exec vitest run test/daw-bridge.test.mjs
pnpm build
```

La compilación estática se genera en `website/dist/`. Para una instalación alojada en un subdirectorio es necesario adaptar también las rutas de las muestras antes de desplegarla.

## Procedencia y licencia

Este estudio deriva de [Strudel, de uzu y sus colaboradores](https://codeberg.org/uzu/strudel/). El código conserva la licencia **AGPL-3.0-or-later** y los avisos originales; consulta [LICENSE](./LICENSE) y [README-UPSTREAM.md](./README-UPSTREAM.md).

La voz utilizada procede de la grabación de «Salgo Pa’ la Calle», de Daddy Yankee con Randy. Los archivos de audio conservan los derechos de sus respectivos titulares; la licencia del código no cambia esos derechos.
