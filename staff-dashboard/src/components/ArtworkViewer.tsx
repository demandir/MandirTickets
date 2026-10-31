import { useEffect } from 'react';
import { artworkFileUrl } from '../services/printerService';
import './ArtworkViewer.css';

interface Props {
  rowId: string;
  fileId?: string;   // Drive file ID — enables instant Google Drive embed
  filename?: string;
  mime?: string;
  onClose: () => void;
}

export default function ArtworkViewer({ rowId, fileId, filename, mime, onClose }: Props) {
  const backendUrl = artworkFileUrl(rowId);
  const driveEmbedUrl = fileId ? `https://drive.google.com/file/d/${fileId}/preview` : null;
  const driveOpenUrl = fileId ? `https://drive.google.com/file/d/${fileId}/view` : backendUrl;
  const isSvg = mime?.toLowerCase() === 'image/svg+xml' || filename?.toLowerCase().endsWith('.svg');
  const isImage = !isSvg && mime?.startsWith('image/');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="av-backdrop" onClick={onClose}>
      <div className="av-frame" onClick={(e) => e.stopPropagation()}>
        <div className="av-bar">
          <div className="av-title"><i className="ti ti-photo" aria-hidden="true" /> {filename || 'Artwork'}</div>
          <div className="av-actions">
            <a className="av-btn" href={driveOpenUrl} target="_blank" rel="noreferrer"><i className="ti ti-external-link" aria-hidden="true" /> Open</a>
            <a className="av-btn" href={backendUrl} download={filename}><i className="ti ti-download" aria-hidden="true" /> Download</a>
            <button className="av-btn av-close" onClick={onClose} aria-label="Close"><i className="ti ti-x" aria-hidden="true" /></button>
          </div>
        </div>
        <div className="av-body">
          {isImage && <img className="av-image" src={driveEmbedUrl || backendUrl} alt={filename || 'Artwork'} />}
          {!isSvg && !isImage && driveEmbedUrl && (
            <iframe className="av-pdf" src={driveEmbedUrl} title={filename || 'Artwork'} allow="autoplay" />
          )}
          {!isImage && (isSvg || !driveEmbedUrl) && (
            <div className="av-fallback">
              <i className="ti ti-file-unknown" aria-hidden="true" />
              <div>Preview not available.</div>
              <a className="av-btn" href={backendUrl} target="_blank" rel="noreferrer"><i className="ti ti-external-link" aria-hidden="true" /> Open in new tab</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
