/**
 * The Kavrin demo lexicon as a plugin.
 *
 * A lexicon source is a plugin because a documentation project will eventually have several
 * (a pilot elicitation, a corpus extract, a legacy word list) and the conflict between them
 * has to be resolvable and explicable. Priority decides; the registry reports the loser.
 *
 * The data itself is invented — see the `notice` field in corpus/demo/corpus.json. It exists
 * to exercise the pipeline, and must never be cited as data about a real language.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const manifest = {
  name: 'kavrin-demo-lexicon',
  version: '0.1.0',
}

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus', 'demo', 'corpus.json')

export function describe() {
  return { plugin: manifest.name, capabilities: ['lexicon.kavrin', 'grammar.kavrin'] }
}

/** The declared morphotactics, so a consumer never has to hard-code them. */
export function grammar() {
  return readCorpus().grammar
}

export function lexemes() {
  return readCorpus().lexemes
}

function readCorpus() {
  return JSON.parse(readFileSync(CORPUS, 'utf8'))
}
