# Sesiones de escritura automática

Biblioteca: `http://localhost:4321/sesiones/`.

`catalog.mjs` reúne 12 versiones: Pa Que V1, Pa Que V2 con sintetizadores,
Pa Que V2 con piano y nueve tomas de Salgo, desde el primer recorte hasta
la estructura Pa Que V1 y la progresiva. Las tomas históricas se conservan
en `my-patterns/historial/`; las actuales siguen usando sus archivos originales.

Cada toma abre en `/sesiones/<id>/`; su código completo se abre en
`/sesiones/<id>/repl/`. Las rutas anteriores de Pa Que y Salgo siguen disponibles.

`score-library.mjs` genera escenas acumulativas desde los marcadores
`// @session`. Los instrumentos se escriben y prueban por etapas; la última
escena utiliza el código completo original de la toma. La duración final
se obtiene de su `arrange`, incluidas las expresiones fraccionarias y los
tramos con cambios de tempo, mediante lectura del AST sin ejecutar el código.

Verificación realizada:

- Las escenas de las 12 versiones compilan y consultan eventos de Strudel.
- El código de cada escena final coincide con el original de esa versión.
- Las 12 páginas responden HTTP 200; el recorte local histórico sigue disponible.
- Escritura progresiva, pausa, salto de escena y cambio del selector probados.
- Mezcla final progresiva: 2:48, arreglo completo con tramos a 185 BPM.
- Sin desbordamiento horizontal a 390 px; sin errores de consola durante las pruebas de reproducción de Pa Que V1 y la progresiva.

Las versiones que usan voz o el primer recorte requieren los archivos privados
ya existentes bajo `/local-audio/`. La toma de piano conserva su banco externo.
