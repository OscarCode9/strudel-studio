# Alinear una entrada con la voz en Salgo Pa’ la Calle

La versión aprobada es [v1.0.7](https://github.com/OscarCode9/strudel-studio/releases/tag/v1.0.7). El primer bombo del segundo drop está en **44.914 s** de la mezcla. La segunda toma empieza en **35.200 s** y el marcador del final de «one, two» está en **9.714 s** del WAV, que dura **9.760 s**. El corte desemboca en el drop y la voz se dispara una sola vez.

## Qué hizo difícil el ajuste

- Mezclé tres referencias: los compases de la Playlist, los segundos de la mezcla y los segundos del WAV. Los compases visuales usan el reloj del proyecto a 185 BPM, aunque ese drop musical vaya a 180 BPM. Medirlo con el tempo del drop o con la posición de una captura puede desplazar el marcador.
- Tomé una transcripción poco fiable como si marcara la sílaba exacta. Los primeros ajustes apuntaban a 5.240 y 4.930 s del WAV. La línea naranja que marcaste mostró que el conteo terminaba unos 4.78 s más tarde.
- Intenté resolverlo moviendo secciones, agregando una pausa y recortando la toma. Eso cambió el arreglo, dejó un tramo mudo en una revisión y duplicó la llamada en otra. El cambio aprobado conserva los cortes, usa una toma corrida y mueve la voz con respecto al bombo. También amplía el WAV medio segundo para incluir el punto marcado.

## Flujo para el próximo ajuste

1. Reproduce en modo **SONG** y pausa donde termina la frase. Anota los segundos que muestra el transporte. Para ubicar un punto en la regla, usa **Alt/⌥ + clic** y ajusta por oído.
2. Pulsa **Alinear voz**. El tiempo de la Playlist se carga en **Segundo en la mezcla**. Pulsa **Pasar a la onda** para convertirlo a segundos del WAV. También puedes hacer clic sobre la onda o introducir el valor directamente.
3. Usa **Probar voz y clic**. El clic simula el instante del bombo sobre la voz aislada. Si el marcador cae fuera del WAV, revisa si usaste el tiempo de la mezcla que está reproduciéndose o si falta cola en la toma. Prueba también el pasaje con la base antes de darlo por bueno.
4. Aplica el valor desde la raíz del repositorio con el comando que muestra la página y comprueba el arreglo. Requiere Node y `ffprobe` de FFmpeg.

   ```sh
   node scripts/set-salgo-cue.mjs 9.714
   node scripts/check-salgo-cue.mjs
   ```

El primer comando cambia solo el marcador de las dos versiones de Strudel. El segundo comprueba que ambas coinciden, que el WAV tiene la duración declarada, que la voz se dispara una vez, que el bombo cae donde corresponde y que el arreglo llega al drop sin un bloque vacío. La posición se calcula como **inicio de la voz + marcador del WAV = primer bombo**. La comprobación valida tiempos y eventos. El final de una sílaba se confirma escuchando.

Si cambias el arreglo, recarga Studio y reproduce desde antes del inicio de la toma para escucharla completa. La prueba con clic y el MP3 exportado son dos cosas distintas. Regenera la mezcla si quieres que el MP3 refleje un nuevo marcador y compara la captura de la Playlist con el audio alrededor de la entrada.
