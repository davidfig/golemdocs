import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': '{name} 여는 중…',
  'viewer.cannotOpen': '{name}을(를) 표시할 수 없습니다: Golem Docs는 이 종류의 파일을 열지 않습니다.',
  'viewer.document': '문서',
  'viewer.previousPage': '이전 페이지',
  'viewer.nextPage': '다음 페이지',
  'viewer.pageNumber': '페이지 번호',
  'viewer.pageCount': '/ {count}',
  'viewer.zoomIn': '확대',
  'viewer.zoomOut': '축소',
  'viewer.actualSize': '실제 크기',
  'viewer.find': '찾기',
  'viewer.closeFind': '찾기 닫기',
  'viewer.findUnavailable': 'PDF 원본 페이지에서는 아직 찾기를 사용할 수 없습니다.',
  'viewer.signIn': '로그인',
  'viewer.signInToView': '이 문서를 보려면 로그인하세요.',
  'viewer.viewOnlyTitle': '{name} (보기 전용)',
};
