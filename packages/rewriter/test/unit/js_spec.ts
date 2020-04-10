import _ from 'lodash'
import { expect } from 'chai'
import { rewriteJs } from '../../lib/js'
import fse from 'fs-extra'
import Bluebird from 'bluebird'
import rp from '@cypress/request-promise'

function match (varName, prop) {
  return `globalThis.top.Cypress.resolveWindowReference(globalThis, ${varName}, '${prop}')`
}

describe('lib/js', function () {
  context('.rewriteJs', function () {
    context('transformations', function () {
      context('injects Cypress window property resolver', () => {
        [
          ['window.top', match('window', 'top')],
          ['window.parent', match('window', 'parent')],
          ['window[\'top\']', match('window', 'top')],
          ['window[\'parent\']', match('window', 'parent')],
          ['window["top"]', match('window', 'top')],
          ['window["parent"]', match('window', 'parent')],
          ['foowindow.top', match('foowindow', 'top')],
          ['foowindow[\'top\']', match('foowindow', 'top')],
          ['window.topfoo'],
          ['window[\'topfoo\']'],
          ['window[\'top\'].foo', `${match('window', 'top')}.foo`],
          ['window.top.foo', `${match('window', 'top')}.foo`],
          ['window.top["foo"]', `${match('window', 'top')}["foo"]`],
          ['window[\'top\']["foo"]', `${match('window', 'top')}["foo"]`],
          [
            'if (window["top"] != window["parent"]) run()',
            `if (${match('window', 'top')} != ${match('window', 'parent')}) run()`,
          ],
          [
            'if (top != self) run()',
            `if ((top === globalThis['top'] ? ${match('globalThis', 'top')} : top) != self) run()`,
          ],
          [
            'if (window != top) run()',
            `if (window != (top === globalThis['top'] ? ${match('globalThis', 'top')} : top)) run()`,
          ],
          [
            'if (top.location != self.location) run()',
            `if (${match('top', 'location')} != ${match('self', 'location')}) run()`,
          ],
          // fun construct found in Apple's analytics code
          [
            'n = (c = n).parent',
            `n = ${match('c = n', 'parent')}`,
          ],
          // more apple goodness - `e` is an element
          [
            'e.top = "0"',
            `globalThis.top.Cypress.resolveWindowReference(globalThis, e, 'top', "0")`,
          ],
          [
            'if (a = (e.top = "0")) { }',
            `if (a = (globalThis.top.Cypress.resolveWindowReference(globalThis, e, 'top', "0"))) { }`,
          ],
          // test that double quotes remain double-quoted
          [
            'a = "b"; window.top',
            `a = "b"; ${match('window', 'top')}`,
          ],
          // test that top/parent are ignored when used as non-variable Identifiers
          ['({ top: "foo", parent: "bar" })'],
          ['top: "foo"; parent: "bar";'],
          ['break top; break parent;'],
          ['continue top; continue parent;'],
          [
            'function top() { window.top }; function parent(...top) { window.top }',
            `function top() { ${match('window', 'top')} }; function parent(...top) { ${match('window', 'top')} }`,
          ],
          [
            '(top, ...parent) => { window.top }',
            `(top, ...parent) => { ${match('window', 'top')} }`,
          ],
          [
            '(function top() { window.top }); (function parent(...top) { window.top })',
            `(function top() { ${match('window', 'top')} }); (function parent(...top) { ${match('window', 'top')} })`,
          ],
          [ // TODO: implement window proxy for destructuring
            'const { top, parent } = window',
            'const { top, parent } = (window === globalThis ? globalThis.top.Cypress.getWindowProxy(globalThis) : window)',
          ],
          [
            'const top = top; const parent = parent;',
            `const top = (top === globalThis['top'] ? ${match('globalThis', 'top')} : top); const parent = (parent === globalThis['parent'] ? ${match('globalThis', 'parent')} : parent);`,
          ],
        ]
        // .slice(0, 1)
        .forEach(([string, expected]) => {
          if (!expected) {
            expected = string
          }

          it(`${string} => ${expected}`, () => {
            const actual = rewriteJs(string)

            expect(actual).to.eq(expected)
          })
        })
      })

      it('replaces jira window getter', () => {
        const jira = `\
  for (; !function (n) {
    return n === n.parent
  }(n);) {}\
  `

        const jira2 = `\
  (function(n){for(;!function(l){return l===l.parent}(l)&&function(l){try{if(void 0==l.location.href)return!1}catch(l){return!1}return!0}(l.parent);)l=l.parent;return l})\
  `

        const jira3 = `\
  function satisfiesSameOrigin(w) {
      try {
          // Accessing location.href from a window on another origin will throw an exception.
          if ( w.location.href == undefined) {
              return false;
          }
      } catch (e) {
          return false;
      }
      return true;
  }

  function isTopMostWindow(w) {
      return w === w.parent;
  }

  while (!isTopMostWindow(parentOf) && satisfiesSameOrigin(parentOf.parent)) {
      parentOf = parentOf.parent;
  }\
  `

        expect(rewriteJs(jira)).to.eq(`\
  for (; !function (n) {
    return n === ${match('n', 'parent')};
  }(n);) {}\
  `)

        expect(rewriteJs(jira2)).to.eq(`\
  (function(n){for(;!function(l){return l===${match('l', 'parent')};}(l)&&function(l){try{if(void 0==${match('l', 'location')}.href)return!1}catch(l){return!1}return!0}(${match('l', 'parent')});)l=${match('l', 'parent')};return l})\
  `)

        expect(rewriteJs(jira3)).to.eq(`\
  function satisfiesSameOrigin(w) {
      try {
          // Accessing location.href from a window on another origin will throw an exception.
          if ( ${match('w', 'location')}.href == undefined) {
              return false;
          }
      } catch (e) {
          return false;
      }
      return true;
  }

  function isTopMostWindow(w) {
      return w === ${match('w', 'parent')};
  }

  while (!isTopMostWindow(parentOf) && satisfiesSameOrigin(${match('parentOf', 'parent')})) {
      parentOf = ${match('parentOf', 'parent')};
  }\
  `)
      })

      // TODO: needs to be updated
      describe('libs', () => {
        const cdnUrl = 'https://cdnjs.cloudflare.com/ajax/libs'

        const needsDash = ['backbone', 'underscore']

        let libs = {
          jquery: `${cdnUrl}/jquery/3.3.1/jquery.js`,
          jqueryui: `${cdnUrl}/jqueryui/1.12.1/jquery-ui.js`,
          angular: `${cdnUrl}/angular.js/1.6.5/angular.js`,
          bootstrap: `${cdnUrl}/twitter-bootstrap/4.0.0/js/bootstrap.js`,
          moment: `${cdnUrl}/moment.js/2.20.1/moment.js`,
          lodash: `${cdnUrl}/lodash.js/4.17.5/lodash.js`,
          vue: `${cdnUrl}/vue/2.5.13/vue.js`,
          backbone: `${cdnUrl}/backbone.js/1.3.3/backbone.js`,
          cycle: `${cdnUrl}/cyclejs-core/7.0.0/cycle.js`,
          d3: `${cdnUrl}/d3/4.13.0/d3.js`,
          underscore: `${cdnUrl}/underscore.js/1.8.3/underscore.js`,
          foundation: `${cdnUrl}/foundation/6.4.3/js/foundation.js`,
          require: `${cdnUrl}/require.js/2.3.5/require.js`,
          rxjs: `${cdnUrl}/rxjs/5.5.6/Rx.js`,
          bluebird: `${cdnUrl}/bluebird/3.5.1/bluebird.js`,
          // NOTE: fontawesome/normalize are css, new rewriter won't intercept CSS
          // fontawesome: `${cdnUrl}/font-awesome/4.7.0/css/font-awesome.css`,
          // normalize: `${cdnUrl}/normalize/8.0.0/normalize.css`,
        }

        libs = _
        .chain(libs)
        .clone()
        .reduce((memo, url, lib) => {
          memo[lib] = url
          memo[`${lib}Min`] = url
          .replace(/js$/, 'min.js')
          .replace(/css$/, 'min.css')

          if (needsDash.includes(lib)) {
            memo[`${lib}Min`] = url.replace('min', '-min')
          }

          return memo
        }
        , {})
        .extend({
          knockoutDebug: `${cdnUrl}/knockout/3.4.2/knockout-debug.js`,
          knockoutMin: `${cdnUrl}/knockout/3.4.2/knockout-min.js`,
          emberMin: `${cdnUrl}/ember.js/2.18.2/ember.min.js`,
          emberProd: `${cdnUrl}/ember.js/2.18.2/ember.prod.js`,
          reactDev: `${cdnUrl}/react/16.2.0/umd/react.development.js`,
          reactProd: `${cdnUrl}/react/16.2.0/umd/react.production.min.js`,
          vendorBundle: 'https://s3.amazonaws.com/internal-test-runner-assets.cypress.io/vendor.bundle.js',
          hugeApp: 'https://s3.amazonaws.com/internal-test-runner-assets.cypress.io/huge_app.js',
        })
        .value() as unknown as typeof libs

        _.each(libs, (url, lib) => {
          it(`does not corrupt code from '${lib}'`, function () {
            // nock.enableNetConnect()

            this.timeout(20000)

            const pathToLib = `/tmp/${lib}`

            const downloadFile = () => {
              return rp(url)
              .then((resp) => {
                return Bluebird.fromCallback((cb) => {
                  fse.writeFile(pathToLib, resp, cb)
                })
                .return(resp)
              })
            }

            return fse
            .readFile(pathToLib, 'utf8')
            .catch(downloadFile)
            .then((libCode) => {
              const stripped = rewriteJs(libCode)

              expect(() => eval(stripped), 'is valid JS').to.not.throw

              // skip for now, no streaming equivalent anyways
              // return new Bluebird((resolve, reject) => {
              //   fse.createReadStream(pathToLib, { encoding: 'utf8' })
              //   .on('error', reject)
              //   .pipe(rewriteJsStream())
              //   .on('error', reject)
              //   .pipe(concatStream({ encoding: 'string' }, resolve))
              //   .on('error', reject)
              // })
              // .then((streamStripped) => {
              //   expect(streamStripped, 'streamed version matches nonstreamed version').to.eq(stripped)
              // })
            })
          })
        })
      })
    })
  })
})