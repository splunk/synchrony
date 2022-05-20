import escodegen from '@javascript-obfuscator/escodegen'
import * as acorn from 'acorn' // no, it cannot be a default import
import * as acornLoose from 'acorn-loose'
import { Transformer, TransformerOptions } from './transformers/transformer'
import { Node, Program, sp } from './util/types'
import Context from './context'
import { walk } from './util/walk'
import { Console } from 'console'

const FILE_REGEX = /(?<!\.d)\.[mc]?[jt]s$/i // cjs, mjs, js, ts, but no .d.ts

// TODO: remove this when https://github.com/acornjs/acorn/commit/a4a5510 lands
type ecmaVersion =
  | 3
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 2015
  | 2016
  | 2017
  | 2018
  | 2019
  | 2020
  | 2021
  | 2022
  | 'latest'

type TransformerArray = [string, Partial<TransformerOptions>][]

export interface DeobfuscateOptions {
  /**
   * ECMA version to use when parsing AST (see acorn, default = 'latest')
   */
  ecmaVersion: ecmaVersion

  /**
   * Replace ChainExpressions with babel-compatible Optional{X}Expessions
   * for work with Prettier
   * https://github.com/prettier/prettier/pull/12172
   * (default = true)
   *
   * @deprecated Prettier is no longer used in the deobfuscator
   */
  transformChainExpressions: boolean

  /**
   * Custom transformers to use
   */
  customTransformers: TransformerArray

  /**
   * Rename identifiers (default = false)
   */
  rename: boolean

  /**
   * Acorn source type
   *
   * Both tries module first then script and uses whichever parses properly
   */
  sourceType: 'both' | 'module' | 'script'

  /**
   * Loose parsing (default = false)
   */
  loose: boolean

  /**
   * Console output
   */
  logger: Console

  /**
   * Disable logging
   */
  quiet: boolean
}

export interface DeobfuscateNodeResult {
  program: Program
  obfuscations?: Object[]
}

export interface DeobfuscationResult {
  source: string
  obfuscations?: Object[]
}

function sourceHash(str: string) {
  let key = 0x94a3fa21
  let length = str.length
  while (length) key = (key * 33) ^ str.charCodeAt(--length)
  return key >>> 0
}

interface SAcornOptions extends Omit<acorn.Options, 'sourceType'> {
  sourceType: 'module' | 'script' | 'both' | undefined
}

export class Deobfuscator {
  public defaultOptions: DeobfuscateOptions = {
    ecmaVersion: 'latest',
    transformChainExpressions: true,
    customTransformers: [],
    rename: false,
    sourceType: 'both',
    loose: false,
    logger: console,
    quiet: false,
  }

  private buildOptions(
    options: Partial<DeobfuscateOptions> = {}
  ): DeobfuscateOptions {
    return { ...this.defaultOptions, ...options }
  }

  private buildAcornOptions(options: DeobfuscateOptions): SAcornOptions {
    return {
      ecmaVersion: options.ecmaVersion,
      sourceType: options.sourceType,
      // this is important for eslint-scope !!!!!!
      ranges: true,
    }
  }

  private parse(
    input: string,
    options: SAcornOptions,
    deobfOptions: DeobfuscateOptions
  ): acorn.Node {
    const a = deobfOptions.loose ? acornLoose : acorn
    if (options.sourceType !== 'both')
      return a.parse(input, options as acorn.Options)

    try {
      options.sourceType = deobfOptions.sourceType = 'module'
      return a.parse(input, options as acorn.Options)
    } catch (err) {
      options.sourceType = deobfOptions.sourceType = 'script'
      return a.parse(input, options as acorn.Options)
    }
  }

  private async deobfuscateNodeInternal(
    node: Program,
    _options?: Partial<DeobfuscateOptions>
  ): Promise<DeobfuscateNodeResult> {
    const options = this.buildOptions(_options)

    const defaultTransformers: TransformerArray = [
      ['Simplify', {}],
      ['MemberExpressionCleaner', {}],
      ['LiteralMap', {}],
      ['DeadCode', {}],
      ['Demangle', {}],

      ['StringDecoder', {}],

      ['Simplify', {}],
      ['MemberExpressionCleaner', {}],

      ['Desequence', {}],
      ['ControlFlow', {}],
      ['Desequence', {}],
      ['MemberExpressionCleaner', {}],

      //['ArrayMap', {}],
      ['Simplify', {}],
      ['DeadCode', {}],
      ['Simplify', {}],
      ['DeadCode', {}],
    ]

    let context = new Context(
      node,
      options.customTransformers.length > 0
        ? options.customTransformers
        : defaultTransformers,
      options.sourceType === 'module',
      undefined,
      options.logger,
      options.quiet
    )

    for (const t of context.transformers) {
      options.logger.log('Running', t.name, 'transformer')
      await t.transform(context)
    }

    if (options.rename) {
      let source = escodegen.generate(context.ast, {
          sourceMapWithCode: true,
        }).code,
        parsed = this.parse(
          source,
          this.buildAcornOptions(options),
          options
        ) as Program
      context = new Context(
        parsed,
        [['Rename', {}]],
        options.sourceType === 'module',
        undefined,
        options.logger,
        options.quiet
      )
      context.hash = sourceHash(source)
      for (const t of context.transformers) {
        options.logger.log('(rename) Running', t.name, 'transformer')
        await t.transform(context)
      }
    }

    return { program: context.ast, obfuscations: context.obfuscations }
  }

  public async deobfuscateNode(
    node: Program,
    _options?: Partial<DeobfuscateOptions>
  ): Promise<Program> {
    let result = await this.deobfuscateNodeInternal(node, _options)
    return result.program
  }

  private async deobfuscateSourceInternal(
    source: string,
    _options?: Partial<DeobfuscateOptions>
  ): Promise<DeobfuscationResult> {
    const options = this.buildOptions(_options)
    const acornOptions = this.buildAcornOptions(options)
    let ast = this.parse(source, acornOptions, options) as Program

    // perform transforms
    let nodeDeobfsResult = await this.deobfuscateNodeInternal(ast, options)
    ast = nodeDeobfsResult.program

    source = escodegen.generate(ast, {
      sourceMapWithCode: true,
    }).code
    try {
      source = prettier.format(source, {
        semi: false,
        singleQuote: true,

        // https://github.com/prettier/prettier/pull/12172
        parser: (text, _opts) => {
          let ast = this.parse(text, acornOptions, options)
          if (options.transformChainExpressions) {
            walk(ast as Node, {
              ChainExpression(cx) {
                if (cx.expression.type === 'CallExpression') {
                  sp<any>(cx, {
                    ...cx.expression,
                    type: 'OptionalCallExpression',
                    expression: undefined,
                  })
                } else if (cx.expression.type === 'MemberExpression') {
                  sp<any>(cx, {
                    ...cx.expression,
                    type: 'OptionalMemberExpression',
                    expression: undefined,
                  })
                }
              },
            })
          }
          return ast
        },
      })
    } catch (err) {
      // I don't think we should log here, but throwing the error is not very
      // important since it is non fatal
      options.logger.log(err)
    }

    return { source: source, obfuscations: nodeDeobfsResult.obfuscations }
  }

  public async deobfuscateSource(
    source: string,
    _options?: Partial<DeobfuscateOptions>
  ): Promise<string> {
    let result = await this.deobfuscateSourceInternal(source, _options)
    return result.source
  }

  public async deobfuscateSourceWithDetails(
    source: string,
    _options?: Partial<DeobfuscateOptions>
  ): Promise<DeobfuscationResult> {
    return this.deobfuscateSourceInternal(source, _options)
  }
}
