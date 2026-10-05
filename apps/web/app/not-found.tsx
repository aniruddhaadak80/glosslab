import Link from 'next/link'

export default function NotFound() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Not found</h1>
          <p>There is no such route in this product.</p>
        </div>
      </div>
      <div className="state">
        <h2>404</h2>
        <p>The corpus browser, the review plan and the surfaces manifest are the only views.</p>
        <Link className="button" href="/">
          back to the corpus
        </Link>
      </div>
    </>
  )
}
